// End-to-end test of the server + client + transfers inside Electron (no UI).
// Run with: npm test
const { app } = require('electron');
const assert = require('assert');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lanshare-test-'));
app.setPath('userData', path.join(tmp, 'profile'));
fs.mkdirSync(app.getPath('userData'), { recursive: true });

const dist = path.join(__dirname, '..', 'dist', 'main');
const { loadConfig, getConfig, saveConfig } = require(path.join(dist, 'config.js'));
const { hashPassword } = require(path.join(dist, 'auth.js'));
const { FileServer } = require(path.join(dist, 'server.js'));
const { RemoteClient, openRequest, waitResponse } = require(path.join(dist, 'client.js'));
const { TransferManager } = require(path.join(dist, 'transfers.js'));

function waitTransfers(tm) {
  return new Promise((resolve) => {
    const check = () => {
      const list = tm.list();
      if (list.length && list.every((t) => !['queued', 'active'].includes(t.status))) {
        tm.off('change', check);
        resolve(list);
      }
    };
    tm.on('change', check);
    check();
  });
}

async function rawStatus(target, urlPath, token) {
  const req = await openRequest(target, 'GET', urlPath, { Authorization: `Bearer ${token}` });
  const res = await waitResponse(req);
  res.resume();
  return res.statusCode;
}

app.whenReady().then(async () => {
  let failed = false;
  try {
    // ---- Set up the "remote" PC: password + one rw and one ro shared folder.
    const rw = path.join(tmp, 'shared-rw');
    const ro = path.join(tmp, 'shared-ro');
    const secret = path.join(tmp, 'secret.txt');
    fs.mkdirSync(path.join(rw, 'sub'), { recursive: true });
    fs.mkdirSync(ro);
    fs.writeFileSync(path.join(rw, 'hello.txt'), 'hello world');
    fs.writeFileSync(path.join(rw, 'sub', 'nested.bin'), Buffer.alloc(3 * 1024 * 1024, 7));
    fs.writeFileSync(secret, 'top secret');

    loadConfig();
    const cfg = getConfig();
    const { hash, salt } = hashPassword('correct-horse');
    cfg.passwordHash = hash;
    cfg.passwordSalt = salt;
    cfg.deviceName = 'TestPC';
    cfg.sharedFolders = [
      { id: 'rw', name: 'Shared', path: rw, readOnly: false },
      { id: 'ro', name: 'Movies', path: ro, readOnly: true },
    ];
    saveConfig();

    const server = new FileServer();
    await server.start();
    const target = { id: 'remote-1', name: 'TestPC', host: '127.0.0.1', port: server.port };
    const client = new RemoteClient(() => target);
    const tm = new TransferManager(client);

    // ---- Auth
    let r = await client.connect('remote-1', { password: 'wrong' }, false);
    assert.equal(r.ok, false);
    assert.match(r.error, /Incorrect password/);
    await assert.rejects(client.roots('remote-1'), /Not connected/);
    console.log('ok  wrong password rejected');

    r = await client.connect('remote-1', { password: 'correct-horse' }, true);
    assert.equal(r.ok, true, r.error);
    assert.ok(getConfig().knownHosts['remote-1'], 'certificate pinned');
    assert.ok(getConfig().savedLogins['remote-1'], 'remember token saved');
    console.log('ok  correct password accepted, cert pinned, login remembered');

    // ---- Browse
    const roots = await client.roots('remote-1');
    assert.deepEqual(roots.map((x) => x.name), ['Shared', 'Movies']);
    const list = await client.list('remote-1', 'rw', '');
    assert.deepEqual(list.entries.map((e) => e.name), ['sub', 'hello.txt']);
    assert.equal((await client.list('remote-1', 'rw', 'sub')).entries[0].size, 3 * 1024 * 1024);
    console.log('ok  roots and folder listing');

    // ---- Path traversal must fail
    const token = client.token('remote-1');
    for (const evil of ['..', '../secret.txt', '..\\secret.txt', 'sub/../../secret.txt', secret, 'C:\\Windows']) {
      const status = await rawStatus(target, `/api/download?root=rw&path=${encodeURIComponent(evil)}`, token);
      assert.equal(status, 404, `traversal ${evil} -> ${status}`);
    }
    assert.equal(await rawStatus(target, '/api/list?root=rw&path=', 'bogus-token'), 401);
    console.log('ok  path traversal and bad tokens blocked');

    // ---- Download file + folder
    const dl = path.join(tmp, 'downloads');
    fs.mkdirSync(dl);
    await tm.download('remote-1', 'rw', '', [{ name: 'hello.txt', isDir: false }, { name: 'sub', isDir: true }], dl);
    let results = await waitTransfers(tm);
    assert.ok(results.every((t) => t.status === 'done'), JSON.stringify(results));
    assert.equal(fs.readFileSync(path.join(dl, 'hello.txt'), 'utf8'), 'hello world');
    assert.equal(fs.statSync(path.join(dl, 'sub', 'nested.bin')).size, 3 * 1024 * 1024);
    // Same again: should not overwrite, gets " (1)".
    tm.clearFinished();
    await tm.download('remote-1', 'rw', '', [{ name: 'hello.txt', isDir: false }], dl);
    await waitTransfers(tm);
    assert.ok(fs.existsSync(path.join(dl, 'hello (1).txt')));
    console.log('ok  download file, folder, and no-overwrite naming');

    // ---- Many small files reuse connections (keep-alive) instead of one TLS handshake per file
    {
      const many = path.join(rw, 'many');
      fs.mkdirSync(many);
      for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(many, `f${i}.txt`), `file ${i}`);
      let handshakes = 0;
      const count = () => handshakes++;
      server.server.on('secureConnection', count);
      tm.clearFinished();
      await tm.download('remote-1', 'rw', '', [{ name: 'many', isDir: true }], dl);
      await new Promise((res) => setTimeout(res, 200)); // Folder walk enqueues asynchronously.
      results = await waitTransfers(tm);
      server.server.off('secureConnection', count);
      assert.ok(results.every((t) => t.status === 'done'), JSON.stringify(results));
      assert.equal(fs.readFileSync(path.join(dl, 'many', 'f19.txt'), 'utf8'), 'file 19');
      assert.ok(handshakes <= 8, `${handshakes} new connections for 21 requests`);
      fs.rmSync(many, { recursive: true });
      console.log(`ok  20 small files over ${handshakes} connection(s)`);
    }

    // ---- Upload file + folder
    const up = path.join(tmp, 'to-upload');
    fs.mkdirSync(path.join(up, 'inner'), { recursive: true });
    fs.writeFileSync(path.join(up, 'a.txt'), 'AAA');
    fs.writeFileSync(path.join(up, 'inner', 'b.txt'), 'BBB');
    tm.clearFinished();
    await tm.upload('remote-1', 'rw', 'sub', [up, path.join(up, 'a.txt')]);
    await new Promise((res) => setTimeout(res, 300)); // Folder walk enqueues asynchronously.
    results = await waitTransfers(tm);
    assert.ok(results.every((t) => t.status === 'done'), JSON.stringify(results));
    assert.equal(fs.readFileSync(path.join(rw, 'sub', 'a.txt'), 'utf8'), 'AAA');
    assert.equal(fs.readFileSync(path.join(rw, 'sub', 'to-upload', 'inner', 'b.txt'), 'utf8'), 'BBB');
    console.log('ok  upload file and folder');

    // ---- Read-only folder rejects upload
    tm.clearFinished();
    await tm.upload('remote-1', 'ro', '', [path.join(up, 'a.txt')]);
    results = await waitTransfers(tm);
    assert.equal(results[0].status, 'error');
    assert.match(results[0].error, /TestPC shares "Movies" as read-only.*Read & write/);
    assert.equal(fs.readdirSync(ro).length, 0);
    console.log('ok  read-only folder rejects uploads');

    // ---- Long transfers: only idle connections time out, not whole requests (Node's default is 5 minutes)
    assert.equal(server.server.requestTimeout, 0);
    assert.equal(server.server.timeout, 60000);
    console.log('ok  no time limit on a whole upload, idle connections still close');

    // ---- Upload cut off partway: the transfer fails with a clear message and nothing goes unhandled
    {
      const unhandled = [];
      const onUnhandled = (err) => unhandled.push(err);
      process.on('unhandledRejection', onUnhandled);
      const { key, cert } = getConfig().tls;
      const cutter = https.createServer({ key, cert }, (req) => req.once('data', () => req.socket.destroy()));
      await new Promise((res) => cutter.listen(0, '127.0.0.1', res));
      const cutTarget = { id: 'remote-cut', name: 'CutPC', host: '127.0.0.1', port: cutter.address().port };
      const cutClient = new RemoteClient(() => cutTarget);
      cutClient.tokens.set('remote-cut', 'token');
      const cutTm = new TransferManager(cutClient);
      const big = path.join(tmp, 'big.bin');
      fs.writeFileSync(big, Buffer.alloc(32 * 1024 * 1024, 1));
      await cutTm.upload('remote-cut', 'rw', '', [big]);
      results = await waitTransfers(cutTm);
      await new Promise((res) => setTimeout(res, 100));
      process.off('unhandledRejection', onUnhandled);
      cutter.close();
      assert.equal(results[0].status, 'error');
      assert.equal(results[0].error, 'The connection was interrupted');
      assert.deepEqual(unhandled, []);
      console.log('ok  upload cut off partway fails cleanly');
    }

    // ---- Phone web page and download links
    {
      const get = async (urlPath, headers = {}) => {
        const req = await openRequest(target, 'GET', urlPath, headers);
        const res = await waitResponse(req);
        const chunks = [];
        for await (const c of res) chunks.push(c);
        return { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) };
      };
      const page = await get('/');
      assert.equal(page.status, 200);
      assert.match(page.body.toString(), /<title>LAN Share<\/title>/);
      assert.match(page.headers['content-security-policy'], /script-src 'self'/);
      assert.equal((await get('/m/app.js')).status, 200);
      assert.equal((await get('/m/../../package.json')).status, 401); // Not a page; falls through to the API auth check.

      const ticket = await client.request('remote-1', 'POST', '/api/ticket?root=rw&path=hello.txt');
      assert.match(ticket.url, /^\/api\/download\?ticket=/);
      const file = await get(ticket.url);
      assert.equal(file.status, 200);
      assert.equal(file.body.toString(), 'hello world');
      assert.match(file.headers['content-disposition'], /attachment; filename="hello.txt"/);
      assert.equal((await get('/api/download?ticket=forged')).status, 401);
      await assert.rejects(client.request('remote-1', 'POST', '/api/ticket?root=rw&path=../secret.txt'), /Path not found/);
      console.log('ok  phone page served, download links work and cannot be forged');
    }

    // ---- Remember-me login works, then password change revokes everything
    client.dropSession('remote-1');
    r = await client.connectSaved('remote-1');
    assert.equal(r.ok, true, r.error);
    server.revokeEverything();
    await assert.rejects(client.roots('remote-1'), /Not authenticated/);
    r = await client.connectSaved('remote-1');
    assert.equal(r.ok, false);
    console.log('ok  remembered login works and is revoked on password change');

    // ---- Pinned identity mismatch is detected
    getConfig().knownHosts['remote-1'] = 'AA:BB';
    r = await client.connect('remote-1', { password: 'correct-horse' }, false);
    assert.equal(r.identityChanged, true);
    client.forgetIdentity('remote-1');
    console.log('ok  changed certificate detected');

    // ---- Lockout after 5 wrong attempts
    for (let i = 0; i < 5; i++) await client.connect('remote-1', { password: 'nope' }, false);
    r = await client.connect('remote-1', { password: 'correct-horse' }, false);
    assert.equal(r.ok, false);
    assert.match(r.error, /Too many wrong attempts/);
    console.log('ok  lockout after 5 wrong passwords');

    server.stop();
    console.log('\nAll tests passed');
  } catch (err) {
    failed = true;
    console.error('\nFAILED:', err);
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Electron keeps its profile folder locked; the OS temp cleaner will remove it.
    }
    app.exit(failed ? 1 : 0);
  }
});
