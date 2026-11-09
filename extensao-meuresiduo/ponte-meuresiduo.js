// Busca a rota pendente desta aba e a entrega ao preenchedor, que roda no contexto da página.
(async () => {
  for (let i = 0; i < 50 && !document.documentElement.dataset.mrPronto; i++) await new Promise((r) => setTimeout(r, 100));
  if (!document.documentElement.dataset.mrPronto) return;
  const r = await chrome.runtime.sendMessage({ tipo: 'minha-rota' });
  if (r && r.rota) window.postMessage({ origem: 'ext-mr-ponte', tipo: 'rota', rota: r.rota }, location.origin);
})();
