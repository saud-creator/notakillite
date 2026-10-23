const nonce = new URLSearchParams(location.hash.slice(1)).get('pair');
history.replaceState(null, '', location.pathname);
const status = document.getElementById('status');
let busy = false;
async function refresh(connect = false, openNotability = false) {
  if (busy) return; busy = true;
  try {
    const result = await chrome.runtime.sendMessage(connect ? { type: 'connect', pairingNonce: nonce, openNotability } : { type: 'status' });
    status.textContent = result?.message || 'Open the Notakillite desktop app, then reconnect.';
    if (result?.ready) { status.style.borderColor = '#8bdcc4'; status.style.color = '#8bdcc4'; }
  } catch { status.textContent = 'The connector is restarting. Keep Notakillite open and try again.'; }
  finally { busy = false; }
}
document.getElementById('open').addEventListener('click', () => refresh(true, true));
void refresh(true);
setInterval(() => void refresh(), 1500);
