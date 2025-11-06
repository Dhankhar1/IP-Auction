function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws`;
  const ws = new WebSocket(url);
  ws.addEventListener('close', () => {
    // attempt simple reconnect after delay
    setTimeout(() => location.reload(), 1500);
  });
  return ws;
}

function onMessage(ev, onState) {
  try {
    const data = JSON.parse(ev.data);
    if (data.type === 'error') {
      console.warn('Error:', data.error);
      return;
    }
    if (data.type === 'state') {
      onState(data.payload);
      return;
    }
    if (data.type === 'login_ok') {
      console.log('Logged in:', data.payload);
      return;
    }
    // ignore others
  } catch (e) {
    console.warn('Bad message', e);
  }
}

// Home page is now static (index.html)
