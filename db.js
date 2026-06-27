const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'msl_calls.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (_) { return []; }
}

function dump(calls) {
  fs.writeFileSync(FILE, JSON.stringify(calls, null, 2));
}

function saveCall(data) {
  const calls = load();
  const idx   = calls.findIndex((c) => c.id === data.id);
  if (idx >= 0) calls[idx] = data;
  else calls.unshift(data);
  dump(calls);
}

function getCalls() { return load(); }
function getCall(id) { return load().find((c) => c.id === id) || null; }

module.exports = { saveCall, getCalls, getCall };
