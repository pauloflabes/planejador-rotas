// Preenche o formulário de nova rota do meuResíduo usando as funções do próprio site.
// Regras fixas: nunca clica em Salvar, nunca usa "Otimizar Rota" e nunca marca "Emitir MTR".
(function () {
  'use strict';
  if (window.__mrPreenchedor) { document.documentElement.dataset.mrPronto = '1'; return; }
  window.__mrPreenchedor = true;

  const REGRA = { termoOrigem: 'MOVI', origem: /MOVI.?ACT/, termoDestino: 'SERQUIP', destino: /UBERLANDIA/ };
  const $ = window.$ && window.$.fn && window.$.fn.select2 ? window.$ : window.jQuery;
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();

  async function ocioso(limite = 30000) {
    const ini = Date.now();
    let calmo = 0;
    while (Date.now() - ini < limite && calmo < 3) { await espera(120); calmo = $.active === 0 ? calmo + 1 : 0; }
    return calmo >= 3;
  }

  // Consulta a mesma busca que o campo Select2 faria ao digitar.
  async function buscar(id, termo) {
    const aj = $('#' + id).data('select2').options.options.ajax;
    const p = { term: termo };
    const r = await $.ajax({ url: typeof aj.url === 'function' ? aj.url(p) : aj.url, type: aj.type || 'POST', dataType: aj.dataType || 'json', data: aj.data ? aj.data(p) : p });
    return aj.processResults ? aj.processResults(r, p).results : r.results;
  }
  const selecionar = (id, item) => $('#' + id).select2('trigger', 'select', { data: item });

  // ---------------------------------------------------------------- painel de acompanhamento
  let painel, corpo;
  function criarPainel() {
    painel = document.createElement('div');
    painel.style.cssText = 'position:fixed;right:16px;bottom:16px;width:380px;max-height:70vh;overflow:auto;z-index:2147483000;background:#fff;color:#222;border:2px solid #1f7a4d;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.3);padding:12px 14px;font:13px/1.45 Arial,sans-serif';
    const t = document.createElement('div');
    t.style.cssText = 'font-weight:bold;margin-bottom:6px;display:flex;justify-content:space-between';
    const n = document.createElement('span'); n.textContent = 'Planejamento de Rotas';
    const x = document.createElement('a'); x.textContent = 'fechar'; x.href = '#'; x.onclick = (e) => { e.preventDefault(); painel.remove(); };
    t.append(n, x);
    corpo = document.createElement('div');
    painel.append(t, corpo);
    document.body.append(painel);
  }
  function linha(txt, cor) {
    const d = document.createElement('div');
    d.textContent = txt;
    if (cor) d.style.color = cor;
    corpo.append(d);
    return d;
  }

  // ---------------------------------------------------------------- etapas
  function instrucoes(rota) {
    $('#Description').val(rota.descricao).trigger('change');
    $('#StartDate').val(rota.data).trigger('change');          // libera o campo de término
    $('#EndDate').val(rota.data).trigger('change');
    $('#IssueMTRWhenGenerateRoute').prop('checked', false);
  }

  async function veiculo(rota, rel) {
    const r = await buscar('License_Plate', rota.placa);
    const it = r.filter((x) => norm(x.id) === norm(rota.placa));
    if (it.length === 1) selecionar('License_Plate', it[0]);
    else rel.erros.push('Placa ' + rota.placa + ' não encontrada no meuResíduo.');
  }

  async function clientes(rota, rel) {
    const prog = linha('Clientes: 0 de ' + rota.clientes.length);
    for (let i = 0; i < rota.clientes.length; i++) {
      const c = rota.clientes[i];
      const r = await buscar('Customer', String(c.id));
      const it = r.filter((x) => String(x.CustomerNumber) === String(c.id));
      if (it.length === 1) { AddCustomer(it[0]); rel.adicionados.push(String(c.id)); }
      else rel.faltando.push(c.id + ' - ' + c.nome);
      prog.textContent = 'Clientes: ' + (i + 1) + ' de ' + rota.clientes.length;
      while ($.active > 4) await espera(60);
    }
    await ocioso();
    customerNComponent.updateTableIndexes();
  }

  function ordemNaTela() {
    const t = $('#tableListCustomer').DataTable();
    return $('#list-customer > tr').toArray().map((tr) => { const d = t.rows(tr).data()[0]; return d ? String(d.exclude_CustomerNumber) : null; }).filter(Boolean);
  }

  async function pontos(rel) {
    $('#typeCompany').prop('checked', true); displayStartEndPoint('Starting');
    const emp = (await buscar('CompanyNumberStarting', REGRA.termoOrigem)).filter((x) => REGRA.origem.test(norm(x.text)));
    if (emp.length === 1) { selecionar('CompanyNumberStarting', emp[0]); validatePoint('Starting'); }
    else rel.erros.push('Empresa de origem não identificada.');

    $('#typeSupplier').prop('checked', true); displayStartEndPoint('Final');
    const des = (await buscar('TempSupplierNumberFinal', REGRA.termoDestino)).filter((x) => REGRA.destino.test(norm(x.text)));
    if (des.length === 1) { selecionar('TempSupplierNumberFinal', des[0]); validatePoint('Final'); }
    else rel.erros.push('Destinatário SERQUIP Uberlândia não identificado.');

    $('#CollectionOrderSupplierTemporaryNumber').val('').trigger('change');   // destinatário temporário fica vazio
    $('#returnGarage').prop('checked', true).trigger('change');
    await ocioso();
    if (!$('#RouteStartingGpsLat').val()) rel.erros.push('Origem sem coordenadas: clique em Validar na aba Rota.');
    if (!$('#RouteFinalGpsLat').val()) rel.erros.push('Destino sem coordenadas: clique em Validar na aba Rota.');
  }

  async function motorista(rota, rel) {
    if (!rota.motorista) { rel.erros.push('Veículo sem motorista cadastrado no planejador.'); return; }
    const alvo = norm(rota.motorista);
    const r = await buscar('Username', rota.motorista.split(' ')[0]);
    let it = r.filter((x) => norm(x.Name) === alvo);
    if (!it.length) it = r.filter((x) => norm(x.Name).includes(alvo));
    if (it.length === 1) { selecionar('Username', it[0]); $('#addUsername').trigger('click'); }
    else rel.erros.push('Motorista "' + rota.motorista + '" não identificado no meuResíduo.');
  }

  async function preencher(rota) {
    criarPainel();
    if (Number($('#CollectionOrderNumber').val()) > 0 || $('#tableListCustomer').DataTable().rows().data().length > 0 || $('#Description').val()) {
      linha('O formulário já tem dados. Nada foi alterado. Abra um formulário em branco e envie novamente.', '#b00020');
      return;
    }
    const rel = { erros: [], faltando: [], adicionados: [] };
    linha('Preenchendo ' + rota.descricao + '...');
    try {
      instrucoes(rota);
      await veiculo(rota, rel);
      await clientes(rota, rel);
      await pontos(rel);
      await motorista(rota, rel);
      await ocioso();
    } catch (e) {
      rel.erros.push('Falha no preenchimento: ' + (e && e.message || e));
    }
    $('#IssueMTRWhenGenerateRoute').prop('checked', false);

    const ordem = ordemNaTela();
    const ordemOk = ordem.length === rel.adicionados.length && ordem.every((id, i) => id === rel.adicionados[i]);
    corpo.textContent = '';
    linha('Preenchimento concluído. Nada foi salvo.', '#1f7a4d').style.fontWeight = 'bold';
    linha(rel.adicionados.length + ' de ' + rota.clientes.length + ' clientes adicionados.');
    linha(ordemOk ? 'Ordem das paradas igual à do planejador.' : 'ATENÇÃO: a ordem na tela difere da do planejador.', ordemOk ? '#1f7a4d' : '#b00020');
    const naoFinal = $('div[id*=divMessageCustomerNotChecked]').length, semContrato = $('div[id*=divMessageCustomerContract]').length;
    if (naoFinal) linha(naoFinal + ' cliente(s) com aviso de rota não finalizada (aba Clientes).', '#b26a00');
    if (semContrato) linha(semContrato + ' cliente(s) com aviso de contrato ou frequência (aba Clientes).', '#b26a00');
    rel.faltando.forEach((f) => linha('Não encontrado: ' + f, '#b00020'));
    rel.erros.forEach((e) => linha(e, '#b00020'));
    linha('Confira as abas e clique em Salvar somente se estiver tudo certo.');
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const m = e.data;
    if (m && m.origem === 'ext-mr-ponte' && m.tipo === 'rota') preencher(m.rota);
  });
  document.documentElement.dataset.mrPronto = '1';
})();
