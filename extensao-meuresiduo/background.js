// Guarda cada rota até o formulário aberto para ela estar pronto.
// A rota fica ligada à aba criada aqui: abrir o formulário à mão nunca dispara o preenchimento.
const FORM = 'https://app.meuresiduo.com/CollectionOrder/getForm';
const PLANEJADOR = ['https://pauloflabes.github.io/planejador-rotas/', 'http://localhost:8765/', 'http://127.0.0.1:8765/'];
const VALIDADE_MS = 30 * 60 * 1000;
const chave = (tabId) => 'rota_' + tabId;

async function pendente(tabId) {
  const k = chave(tabId);
  const g = await chrome.storage.session.get(k);
  const p = g[k];
  if (!p) return null;
  if (Date.now() - p.criadoEm > VALIDADE_MS) { await chrome.storage.session.remove(k); return null; }
  return p;
}

chrome.runtime.onMessage.addListener((m, sender, responder) => {
  (async () => {
    if (m.tipo === 'enviar') {
      if (!PLANEJADOR.some((p) => (sender.url || '').startsWith(p))) return responder({ ok: false, erro: 'Origem não autorizada.' });
      const tab = await chrome.tabs.create({ url: FORM });
      await chrome.storage.session.set({ [chave(tab.id)]: { rota: m.rota, criadoEm: Date.now() } });
      return responder({ ok: true });
    }
    if (m.tipo === 'minha-rota') {
      const p = await pendente(sender.tab.id);
      if (p) await chrome.storage.session.remove(chave(sender.tab.id));   // uso único
      return responder({ rota: p ? p.rota : null });
    }
    responder({ ok: false });
  })().catch((e) => responder({ ok: false, erro: String(e && e.message || e) }));
  return true;
});

// Se o usuário precisou fazer login, leva a aba de volta ao formulário depois de entrar.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete' || !tab.url || !tab.url.startsWith('https://app.meuresiduo.com/')) return;
  const { pathname } = new URL(tab.url);
  if (pathname === '/' || /login/i.test(pathname) || /CollectionOrder\/getForm/i.test(pathname)) return;
  if (await pendente(tabId)) chrome.tabs.update(tabId, { url: FORM });
});

chrome.tabs.onRemoved.addListener((tabId) => { chrome.storage.session.remove(chave(tabId)); });
