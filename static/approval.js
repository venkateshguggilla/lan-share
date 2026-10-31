// Accept / reject popup: a device entered the right password and waits for this PC to let it in.
'use strict';

const id = new URLSearchParams(location.search).get('id');
const $ = (x) => document.getElementById(x);
const TIMEOUT_S = 60;

function respond(decision) {
  for (const b of document.querySelectorAll('button')) b.disabled = true;
  window.api.approvalRespond(id, decision);
}

(async function init() {
  const req = await window.api.approvalInfo(id);
  if (!req) return window.close(); // Already answered or the device gave up.
  $('title').textContent = `${req.clientName} wants to connect`;
  $('detail').textContent = `${req.kind === 'phone' ? 'Phone or browser' : 'PC'} at ${req.ip}`;
  $('explain').textContent =
    `${req.clientName} entered your LAN Share password. Let it see your shared folders? ` +
    'Only allow devices you recognise.';
  document.title = `${req.clientName} wants to connect`;

  $('reject').addEventListener('click', () => respond('reject'));
  $('once').addEventListener('click', () => respond('once'));
  $('always').addEventListener('click', () => respond('always'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') respond('reject');
  });

  let left = TIMEOUT_S;
  const tick = () => {
    $('countdown').textContent = `Rejected automatically in ${left} s`;
    left--;
  };
  tick();
  setInterval(tick, 1000);
  $('reject').focus(); // A stray Enter key never lets a device in.
})();
