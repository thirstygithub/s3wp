let socket = null;
const inbox = [];
const outbox = [];

function relayUrl() {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/net`;
}

export function open() {
  if (socket) return;
  inbox.length = 0;
  outbox.length = 0;
  let ws;
  try {
    ws = new WebSocket(relayUrl());
  } catch (error) {
    inbox.push(`STATUS ERROR: could not reach the game server (${error.message || error}).`);
    return;
  }
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    for (const message of outbox.splice(0)) ws.send(message);
  };
  ws.onmessage = (event) => {
    inbox.push(typeof event.data === 'string' ? event.data : new Uint8Array(event.data));
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    inbox.push('STATUS ERROR: disconnected from the game server. Host or join again to reconnect.');
  };
  socket = ws;
}

export function close() {
  const ws = socket;
  socket = null;
  outbox.length = 0;
  if (ws) ws.close();
}

function post(message) {
  if (!socket) return false;
  if (socket.readyState === WebSocket.CONNECTING) {
    outbox.push(message);
    return true;
  }
  if (socket.readyState !== WebSocket.OPEN) return false;
  socket.send(message);
  return true;
}

export const send = (frame) => post(frame.slice());
export const text = (message) => post(String(message));
export const poll = () => inbox.splice(0);

export const backlog = () => (socket ? socket.bufferedAmount : 0);
