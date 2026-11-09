// Liga a página do Planejamento de Rotas à extensão.
document.documentElement.dataset.extMeuresiduo = chrome.runtime.getManifest().version;

window.addEventListener('message', (e) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const m = e.data;
  if (!m || m.origem !== 'planejador-rotas' || m.tipo !== 'enviar-rota') return;
  const responder = (r) => window.postMessage({ origem: 'extensao-meuresiduo', tipo: 'resposta', id: m.id, ok: !!(r && r.ok), erro: r && r.erro }, location.origin);
  try {
    chrome.runtime.sendMessage({ tipo: 'enviar', rota: m.rota }, (r) => {
      if (chrome.runtime.lastError) return responder({ ok: false, erro: chrome.runtime.lastError.message });
      responder(r);
    });
  } catch (err) { responder({ ok: false, erro: 'A extensão foi atualizada. Recarregue esta página.' }); }
});
