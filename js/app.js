/* Interface do protótipo de otimização de rotas de coleta */
(function () {
  'use strict';
  const M = window.Modelo, A = window.Armazen, Sync = A.Sync;
  const CORES = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2'];
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtR = (v) => 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtN = (v, d) => (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  const fmtH = (min) => { min = Math.round(min || 0); return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`; };
  const hojeReal = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  // Mapa de fundo. O servidor do OpenStreetMap exige o cabeçalho Referer, que o navegador não envia quando a
  // página é aberta direto do disco (file://). Nesse caso usa o mapa de ruas da Esri, que não exige chave.
  const viaDisco = location.protocol === 'file:';
  const camadaBase = () => viaDisco
    ? L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, attribution: 'Mapa © Esri, HERE, Garmin, © OpenStreetMap' })
    : L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' });

  // ------------------------------------------------------------------ estado
  let st = A.Local.carregar();
  // começa em branco (e descarta dados fictícios de versões antigas do protótipo)
  if (!st || st.versao !== 1 || (st.clientes.length && st.clientes.every(c => c.ficticio))) st = M.estadoInicial(hojeReal());
  M.migrar(st);
  let matriz = A.Local.carregarMatriz();
  let mapCli = new Map();
  const idxCli = () => { mapCli = new Map(st.clientes.map(c => [c.id, c])); };
  idxCli();
  const veicIdx = (id) => st.veiculos.findIndex(v => v.id === id);
  const corV = (id) => CORES[Math.max(0, veicIdx(id)) % CORES.length];
  const nomeCli = (id) => (mapCli.get(id) || { nome: id }).nome;

  let syncTimer = null, syncErro = null;
  function salvar(semSync) {
    st.atualizadoEm = new Date().toISOString();
    if (!A.Local.salvar(st)) alerta('Não foi possível gravar no armazenamento do navegador. Exporte um backup.');
    if (!semSync && Sync.ativo() && Sync.cfg.auto) { clearTimeout(syncTimer); syncTimer = setTimeout(enviarNuvem, 2500); }
  }
  function marcarDesatualizado() { st.planoDesatualizado = true; salvar(); renderBanner(); }
  function alerta(msg) { window.alert(msg); }

  // ------------------------------------------------------------------ worker do otimizador
  let worker = null, reqId = 0;
  const pend = new Map();
  function getWorker() {
    if (worker) return worker;
    const src = SolverFactory.toString() + '\n' + SolverWorkerMain.toString() + '\nSolverWorkerMain(self);';
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = (e) => {
      const m = e.data, p = pend.get(m.id);
      if (!p) return;
      if (m.type === 'progress') { if (p.onProgress) p.onProgress(m); }
      else if (m.type === 'done') { pend.delete(m.id); p.resolve(m.result); }
      else if (m.type === 'error') { pend.delete(m.id); p.reject(new Error(m.message)); }
    };
    return worker;
  }
  // Rodadas paralelas cooperativas: várias rodadas com sementes diferentes, uma por núcleo do processador;
  // periodicamente todas adotam a melhor solução encontrada até ali. Fica com o melhor resultado.
  let srcWorker = null;
  const pool = [];
  function novoWorker() {
    if (!srcWorker) srcWorker = URL.createObjectURL(new Blob([SolverFactory.toString() + '\n' + SolverWorkerMain.toString() + '\nSolverWorkerMain(self);'], { type: 'text/javascript' }));
    return new Worker(srcWorker);
  }
  function nParalelas() { return Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)); }
  function otimizarParalelo(P, seg, onProgress) {
    const k = nParalelas();
    while (pool.length < k) pool.push(novoWorker());
    const ws = pool.slice(0, k);
    const prog = new Array(k).fill(null);
    return new Promise((resolve, reject) => {
      const res = new Array(k);
      let faltam = k, coletados = [], trocas = 0;
      const distribuir = () => {
        if (!coletados.length) return;
        const b = coletados.reduce((a, x) => (x.cost < a.cost ? x : a));
        ws.forEach((w, j) => { if (j !== b.i && res[j] === undefined) w.postMessage({ type: 'adotar', snap: b.snap, cost: b.cost }); });
        coletados = []; trocas++;
      };
      const timer = setInterval(() => {
        coletados = [];
        ws.forEach((w, j) => { if (res[j] === undefined) w.postMessage({ type: 'melhor' }); });
        setTimeout(distribuir, 1500);
      }, Math.max(20000, seg * 1000 / 5));
      ws.forEach((w, i) => {
        w.onmessage = (e) => {
          const m = e.data;
          if (m.type === 'progress') { prog[i] = m; onProgress(prog, k); }
          else if (m.type === 'melhor') coletados.push({ i, cost: m.cost, snap: m.snap });
          else if (m.type === 'done') {
            res[i] = m.result;
            if (--faltam === 0) {
              clearInterval(timer);
              const melhor = res.reduce((a, r) => (r.cost < a.cost ? r : a));
              melhor.stats.paralelas = k; melhor.stats.trocas = trocas;
              melhor.stats.custosRodadas = res.map(r => Math.round(r.cost * 100) / 100);
              resolve(melhor);
            }
          } else if (m.type === 'error') { clearInterval(timer); reject(new Error(m.message)); }
        };
        const Pi = Object.assign({}, P, { params: Object.assign({}, P.params, { seed: (P.params.seed || 7) + i * 101 }) });
        w.postMessage({ type: 'solve', id: 1, problem: Pi });
      });
    });
  }
  function chamar(type, payload, onProgress) {
    const id = ++reqId;
    return new Promise((resolve, reject) => {
      pend.set(id, { resolve, reject, onProgress });
      getWorker().postMessage(Object.assign({ type, id }, payload));
    });
  }

  // ------------------------------------------------------------------ otimização
  let ocupado = false;
  async function otimizar(modo, motivo) {
    if (ocupado) return;
    ocupado = true;
    const t0 = performance.now();
    const prob = M.montarProblema(st, matriz);
    const tMont = performance.now() - t0;
    if (!prob.P.tasks.length) { ocupado = false; alerta('Não há coletas para programar no horizonte.'); return; }
    if (modo === 'zero') prob.P.tasks.forEach(t => { t.init = null; t.prevOpt = -1; t.changePen = 0; });
    const seg = modo === 'zero' ? st.params.tempoCompleto : st.params.tempoDiario;
    prob.P.params.timeLimitMs = seg * 1000;
    $('mdTit').textContent = modo === 'zero' ? 'Otimizando do zero…' : 'Reotimizando a partir do plano atual…';
    $('mdSub').textContent = `${motivo ? motivo + ' · ' : ''}${prob.P.tasks.length} grupos de visita · ${prob.dias.length} dias úteis · distâncias: ${prob.fonte}`;
    $('mdBar').style.width = '0%'; $('mdInfo').textContent = 'Montando solução inicial…';
    $('modal').classList.add('on');
    try {
      const res = await otimizarParalelo(prob.P, seg, (prog, k) => {
        const ps = prog.filter(Boolean);
        if (!ps.length) return;
        const ms = Math.max(...ps.map(p => p.ms)), it = ps.reduce((s, p) => s + p.iter, 0), best = Math.min(...ps.map(p => p.best));
        $('mdBar').style.width = Math.min(100, 100 * ms / ps[0].limit).toFixed(0) + '%';
        $('mdInfo').textContent = `${(ms / 1000).toFixed(0)} s de ${seg} s · ${k} rodada(s) em paralelo · ${fmtN(it)} iterações · melhor custo ${fmtR(best)}`;
      });
      res.stats.montagemMs = Math.round(tMont);
      M.aplicarResultado(st, prob, res);
      st.plano.modo = modo; st.plano.motivo = motivo || '';
      st.planoDesatualizado = false;
      salvar();
    } catch (e) {
      console.error(e); alerta('Erro na otimização: ' + e.message);
    } finally {
      $('modal').classList.remove('on');
      ocupado = false;
      renderTudo();
    }
  }
  $('mdParar').onclick = () => { pool.forEach(w => w.postMessage({ type: 'stop' })); if (worker) worker.postMessage({ type: 'stop' }); };

  // ------------------------------------------------------------------ consultas ao plano
  function rotasDoDia(dia) {
    if (st.confirmados[dia]) return { conf: true, auto: !!st.confirmados[dia].auto, rotas: st.confirmados[dia].rotas };
    if (st.plano && st.plano.dias && st.plano.dias[dia] && dia > st.params.hoje) return { conf: false, rotas: st.plano.dias[dia] };
    return null;
  }
  function proximoRevisar() {
    const cal = M.calendario(st);
    const uc = M.ultimoConfirmado(st);
    let n = Math.max(M.dnum(st.params.hoje), uc ? M.dnum(uc) : -1) + 1;
    for (let k = 0; k < 30; k++, n++) if (cal.diaUtilFrota(M.dstr(n))) return M.dstr(n);
    return null;
  }
  function proximasDatas() {
    const m = new Map();
    if (!st.plano) return m;
    for (const [dia, rotas] of Object.entries(st.plano.dias)) {
      if (dia <= st.params.hoje || st.confirmados[dia]) continue;
      for (const r of rotas) for (const c of r.clientes) { if (!m.has(c)) m.set(c, []); m.get(c).push(dia); }
    }
    for (const [dia, cf] of Object.entries(st.confirmados)) {
      if (dia <= st.params.hoje) continue;
      for (const r of cf.rotas) for (const c of r.clientes) { if (!m.has(c)) m.set(c, []); m.get(c).push(dia); }
    }
    for (const v of m.values()) v.sort();
    return m;
  }

  // ------------------------------------------------------------------ navegação
  let vista = 'painel';
  const PAI = { novo: 'clientes', importar: 'config' }; // sub-abas
  document.querySelectorAll('#nav button, .subtabs button').forEach(b => b.onclick = () => irPara(b.dataset.v));
  function irPara(v) {
    vista = v;
    document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.v === (PAI[v] || v)));
    document.querySelectorAll('.subtabs button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
    window.scrollTo(0, 0);
    document.querySelectorAll('main section').forEach(s => s.classList.toggle('on', s.id === 'v-' + v));
    renderVista();
  }
  function renderTudo() { renderCabecalho(); renderBanner(); renderVista(); }
  function renderVista() {
    ({ painel: renderPainel, calendario: renderCalendario, dia: renderDia, clientes: renderClientes, novo: renderNovo,
      frota: renderFrota, avulsas: renderAvulsas, config: renderConfig, historico: renderHistorico, importar: renderImportar })[vista]();
  }

  function renderCabecalho() {
    $('hojeTxt').textContent = M.fmtCurto(st.params.hoje) + '/' + st.params.hoje.slice(0, 4);
    const t = $('syncTag');
    if (!Sync.ativo()) { t.textContent = 'somente local'; t.className = 'tag'; }
    else if (syncErro) { t.textContent = 'sincronização: ' + syncErro; t.className = 'tag bad'; }
    else { t.textContent = 'sincronizado' + (Sync.cfg.remotoEm ? ' ' + new Date(Sync.cfg.remotoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : ''); t.className = 'tag ok'; }
    const dl = $('dlClientes');
    dl.innerHTML = st.clientes.filter(c => c.ativo).map(c => `<option value="${esc(c.id + ' — ' + c.nome)}"></option>`).join('');
  }

  function renderBanner() {
    const b = $('bannerArea');
    let h = '';
    if (viaDisco) h += `<div class="banner warn">O programa foi aberto direto do arquivo. Para a busca de endereços e as distâncias pelas ruas funcionarem, abra pelo <b>iniciar.bat</b> (ou pelo endereço publicado).</div>`;
    if (!st.clientes.some(c => c.ativo)) h += Sync.ativo()
      ? `<div class="banner"><div><b>Conectado como ${esc(Sync.cfg.email)}.</b> Ainda não há dados na nuvem: importe os relatórios do meuResíduo para começar. Os dados serão compartilhados com a equipe.</div>
        <button class="b p" data-acao="importar">Importar do meuResíduo</button></div>`
      : `<div class="banner"><div><b>Bem-vindo ao Planejamento de Rotas.</b> Entre com seu login para carregar os dados da equipe, ou importe os relatórios do meuResíduo para usar só neste navegador.</div>
        <button class="b p" data-acao="login">Entrar</button><button class="b" data-acao="importar">Importar do meuResíduo</button></div>`;
    else if (!st.plano) h += `<div class="banner warn">Ainda não há plano de rotas. <button class="b p" data-acao="zero">Otimizar agora</button></div>`;
    else if (st.planoDesatualizado) h += `<div class="banner warn">Houve alterações desde a última otimização. <button class="b p" data-acao="quente">Reotimizar</button></div>`;
    if (conflitoSync) h += `<div class="banner warn">A nuvem tem uma versão mais nova (salva em ${new Date(conflitoSync).toLocaleString('pt-BR')}).
      <button class="b" data-acao="baixar">Carregar a versão da nuvem</button><button class="b" data-acao="forcar">Sobrescrever a nuvem com a minha</button></div>`;
    b.innerHTML = h;
    b.querySelectorAll('button').forEach(x => x.onclick = () => {
      const a = x.dataset.acao;
      if (a === 'zero') otimizar('zero', 'Primeiro plano');
      else if (a === 'importar') irPara(a);
      else if (a === 'login') abrirLogin();
      else if (a === 'quente') otimizar('quente', 'Alterações de cadastro');
      else if (a === 'baixar') baixarNuvem(true);
      else if (a === 'forcar') enviarNuvem(true);
    });
  }

  // ------------------------------------------------------------------ PAINEL
  function renderPainel() {
    $('horizTxt').textContent = st.params.horizonte;
    const pr = proximoRevisar();
    const rd = pr ? rotasDoDia(pr) : null;
    $('proxRevisao').innerHTML = pr ? `<div class="row" style="justify-content:space-between">
        <div><b>Próxima rota a revisar: ${M.fmtCurto(pr)}</b><div class="small muted">${rd ? rd.rotas.map(r => `<span class="dot" style="background:${corV(r.veiculoId)}"></span> ${esc(st.veiculos[veicIdx(r.veiculoId)]?.nome || r.veiculoId)}: ${r.clientes.length} paradas, ${fmtN(r.km, 1)} km`).join(' &nbsp; ') : 'sem rota planejada para este dia'}</div></div>
        <button class="b p" id="btnRevisar">Revisar e confirmar</button></div>` : 'Sem dias úteis próximos.';
    if ($('btnRevisar')) $('btnRevisar').onclick = () => { diaAtual = pr; irPara('dia'); };

    const k = $('kpis');
    if (!st.plano) { k.innerHTML = '<div class="muted">Sem plano.</div>'; $('comparacao').innerHTML = ''; $('convergencia').innerHTML = ''; $('alertas').innerHTML = ''; $('ultimaOtim').textContent = ''; return; }
    const r = st.plano.resumo, s = st.plano.stats;
    const tiles = [
      ['Combustível previsto', fmtR(r.combustivel), `${fmtN(r.litros)} litros de combustível`],
      ['Distância total', fmtN(r.km) + ' km', `${fmtN(r.km / Math.max(1, r.nDias), 1)} km por dia útil`],
      ['Visitas programadas', fmtN(r.visitas), `${r.nDias} dias úteis`],
      ['Custo por visita', fmtR(r.combustivel / Math.max(1, r.visitas)), 'só combustível'],
      ['Tempo de otimização', (s.ms / 1000).toFixed(1) + ' s', `${s.paralelas ? s.paralelas + ' rodadas em paralelo · ' : ''}${fmtN(s.iter)} iterações (melhor rodada)`],
    ];
    k.innerHTML = tiles.map(t => `<div class="kpi"><div class="l">${t[0]}</div><div class="v">${t[1]}</div><div class="small muted">${t[2]}</div></div>`).join('');
    $('ultimaOtim').textContent = `Último plano: ${new Date(st.plano.geradoEm).toLocaleString('pt-BR')} (${st.plano.modo === 'zero' ? 'do zero' : 'a partir do plano anterior'}${st.plano.motivo ? ' — ' + st.plano.motivo : ''}). Distâncias: ${({ estimativa: 'estimadas (linha reta × fator)', ruas: 'pelas ruas (OSRM)', misto: 'pelas ruas, com alguns pontos estimados' })[r.fonteDistancias]}.`;
    $('btnReotimizar').textContent = `Reotimizar a partir do plano atual (${st.params.tempoDiario} s)`;
    $('btnOtimizarZero').textContent = `Otimizar do zero (${st.params.tempoCompleto} s)`;

    const ref = r.referencia;
    if (ref) {
      const ec = 1 - r.combustivel / ref.fuel;
      $('comparacao').innerHTML = `<table>
        <tr><th></th><th class="n">Referência</th><th class="n">Otimizado</th></tr>
        <tr><td>Distância</td><td class="n">${fmtN(ref.km)} km</td><td class="n">${fmtN(r.km)} km</td></tr>
        <tr><td>Combustível</td><td class="n">${fmtR(ref.fuel)}</td><td class="n">${fmtR(r.combustivel)}</td></tr>
        <tr><td>Horas além da jornada</td><td class="n">${fmtH(ref.overMin)}</td><td class="n">${fmtH(r.extraMin)}</td></tr>
        </table>
        <p><b class="${ec > 0 ? 'ok' : 'bad'}">${ec > 0 ? 'Economia' : 'Diferença'} estimada: ${fmtN(Math.abs(ec) * 100, 0)}%</b></p>
        <p class="small muted">Referência ingênua: cada cliente exatamente na data-alvo, veículos divididos por setor do mapa e
        sequência por vizinho mais próximo com 2-opt. Serve para comparar versões do plano. Quando houver dados reais,
        a comparação justa é com as rotas que vocês montam hoje no meuResíduo.</p>`;
    } else $('comparacao').innerHTML = '<span class="muted">—</span>';

    $('convergencia').innerHTML = graficoConvergencia(s.history || [], s.ms);

    const al = [];
    if (st.plano.naoAlocadas.length) al.push(`<div class="bad"><b>${st.plano.naoAlocadas.length} visita(s) não couberam no horizonte</b> (falta de veículo ou de jornada):</div><ul>${st.plano.naoAlocadas.slice(0, 30).map(x => `<li>${esc(nomeCli(x.clienteId))} — janela ${M.fmtCurto(x.janela[0])} a ${M.fmtCurto(x.janela[1])}</li>`).join('')}</ul>`);
    if (r.atrasadas) al.push(`<div class="warn">${r.atrasadas} visita(s) programadas depois da janela de tolerância (atraso controlado).</div>`);
    if (r.rotasAcimaAlvo) al.push(`<div class="muted">${r.rotasAcimaAlvo} de ${r.rotasUsadas} rota(s) passam da jornada-alvo de ${fmtN(st.params.jornadaAlvoH, 1)} h (limite: ${fmtN(st.params.jornadaH, 1)} h), em geral quando o outro veículo está em viagem longa.</div>`);
    if (r.extraMin > 0.5) al.push(`<div class="warn">Rotas que passam da jornada: total de ${fmtH(r.extraMin)} além do limite.</div>`);
    if (r.extraKg > 0.5) al.push(`<div class="bad">Excesso de carga: ${fmtN(r.extraKg)} kg acima da capacidade somando todas as rotas.</div>`);
    if (r.intervalosFora) al.push(`<div class="muted">${r.intervalosFora} par(es) de coletas consecutivas com intervalo fora da tolerância.</div>`);
    if (r.mudancas) al.push(`<div class="muted">${r.mudancas} visita(s) mudaram de dia em relação ao plano anterior.</div>`);
    const ind = st.indisponibilidades.filter(x => x.ate >= st.params.hoje);
    if (ind.length) al.push(`<div>Veículos inoperantes: ${ind.map(x => `${esc(st.veiculos[veicIdx(x.veiculoId)]?.nome || x.veiculoId)} de ${M.fmtData(x.de)} a ${M.fmtData(x.ate)}`).join('; ')}</div>`);
    $('alertas').innerHTML = al.length ? al.join('') : '<span class="ok">Nenhuma pendência: todas as visitas dentro das janelas, da jornada e da capacidade.</span>';
  }
  $('btnReotimizar').onclick = () => otimizar('quente', 'Reotimização manual');
  $('btnOtimizarZero').onclick = () => { if (!st.plano || confirm('Otimizar do zero ignora o plano atual (as datas podem mudar bastante). Continuar?')) otimizar('zero', 'Otimização completa'); };

  function graficoConvergencia(h, ms) {
    if (h.length < 2) return '<span class="muted">—</span>';
    const W = 520, H = 200, L = 64, B = 28, T = 10, Rr = 10;
    const xMax = Math.max(ms, h[h.length - 1][0]) / 1000;
    const ys = h.map(p => p[1]);
    const yMin = Math.min(...ys), yMax = Math.max(...ys);
    const x = (v) => L + (W - L - Rr) * v / xMax, y = (v) => T + (H - T - B) * (1 - (v - yMin) / Math.max(1, yMax - yMin));
    let d = '';
    h.forEach((p, i) => { const px = x(p[0] / 1000), py = y(p[1]); d += i === 0 ? `M${px},${py}` : `H${px}V${py}`; });
    d += `H${x(xMax)}`;
    const tx = [0, xMax / 2, xMax].map(v => `<text x="${x(v)}" y="${H - 8}" text-anchor="middle">${v.toFixed(0)} s</text>`).join('');
    const ty = [yMin, (yMin + yMax) / 2, yMax].map(v => `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmtR(v).replace('R$ ', 'R$')}</text><line x1="${L}" x2="${W - Rr}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/>`).join('');
    const ultimo = h[h.length - 1][1], prim = h[0][1];
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Custo da melhor solução ao longo do tempo">${ty}${tx}
      <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2"/></svg>
      <div class="small muted">Custo da melhor solução (combustível + penalidades) ao longo do tempo: de ${fmtR(prim)} para ${fmtR(ultimo)}.
      Quando a curva fica plana, mais tempo quase não melhora o resultado.</div>`;
  }

  // ------------------------------------------------------------------ CALENDÁRIO
  function renderCalendario() {
    const cal = M.calendario(st);
    $('legendaV').innerHTML = st.veiculos.map(v => `<span><span class="dot" style="background:${corV(v.id)}"></span> ${esc(v.nome)}</span>`).join('');
    const hojeN = M.dnum(st.params.hoje);
    const ini = hojeN - ((M.wday(hojeN) + 6) % 7);
    const fimS = st.plano ? st.plano.ultimoDia : M.dstr(hojeN + st.params.horizonte);
    const fim = Math.max(M.dnum(fimS), hojeN + 7);
    // busca de cliente: dias em que ele está programado (e em qual veículo)
    const hits = new Map();
    const cBusca = calCliente ? mapCli.get(calCliente) : null;
    if (cBusca) {
      for (let n = hojeN + 1; n <= fim; n++) {
        const rd = rotasDoDia(M.dstr(n));
        const r = rd && rd.rotas.find(x => x.clientes.includes(cBusca.id));
        if (r) hits.set(M.dstr(n), { veiculoId: r.veiculoId, pos: r.clientes.indexOf(cBusca.id) + 1, conf: rd.conf });
      }
      const nomeV = (id) => esc(st.veiculos[veicIdx(id)]?.nome || id);
      let motivo = '';
      if (!hits.size) motivo = !cBusca.ativo ? 'Cliente inativo: não entra nas rotas.' : !M.temCoord(cBusca) ? 'Cliente sem localização: não entra nas rotas.'
        : cBusca.freq === 'demanda' ? 'Coleta conforme necessidade: programe pela aba Coletas avulsas.' : 'Nenhuma coleta programada no horizonte do plano (reotimize se houve alterações).';
      $('calBuscaRes').innerHTML = `<b>${esc(cBusca.nome)}</b> <span class="muted">· ${esc(M.FREQ[cBusca.freq]?.nome || '')} · última coleta: ${cBusca.ultimaColeta ? M.fmtData(cBusca.ultimaColeta) : '—'}</span><br>` +
        (hits.size ? `Próximas coletas: ${[...hits].map(([d, x]) => `<span class="tag"><span class="dot" style="background:${corV(x.veiculoId)}"></span> ${M.fmtCurto(d)}/${d.slice(0, 4)} · ${nomeV(x.veiculoId)} · ${x.pos}ª parada${x.conf ? ' · confirmada' : ''}</span>`).join(' ')}`
          : `<span class="warn">${motivo}</span>`);
    } else $('calBuscaRes').innerHTML = '';
    const nc = st.params.sabado ? 6 : 5;
    let h = `<div class="cal" style="grid-template-columns:repeat(${nc},minmax(0,1fr))">`;
    h += ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb'].slice(0, nc).map(x => `<div class="h">${x}</div>`).join('');
    for (let n = ini; n <= fim; n++) {
      const w = M.wday(n);
      if (w === 0 || (w === 6 && !st.params.sabado)) continue;
      const s = M.dstr(n);
      const [, mm, dd] = s.split('-');
      if (!cal.diaUtilFrota(s)) { h += `<div class="c hol"><div class="d"><span>${dd}/${mm}</span></div><div>${esc(cal.motivo(s))}</div></div>`; continue; }
      const rd = rotasDoDia(s);
      const past = n <= hojeN;
      let corpo = '';
      st.veiculos.forEach((v, i) => {
        const fora = st.indisponibilidades.some(x => x.veiculoId === v.id && s >= x.de && s <= x.ate);
        const r = rd && rd.rotas.find(x => x.veiculoId === v.id);
        if (fora) corpo += `<div class="vline bad"><span class="dot" style="background:${corV(v.id)}"></span>inoperante</div>`;
        else if (r && r.clientes.length) corpo += `<div class="vline"><span class="dot" style="background:${corV(v.id)}"></span>${r.clientes.length} · ${fmtN(r.km)} km${r.extraMin > 1 ? ' <span class="warn">⏱</span>' : ''}</div>`;
      });
      const badge = rd && rd.conf ? `<span class="tag ok">${past ? 'feita' : 'confirmada'}</span>` : '';
      const hit = hits.get(s);
      const marca = hit ? `<span class="alvo">● ${esc(st.veiculos[veicIdx(hit.veiculoId)]?.nome || '')}, ${hit.pos}ª parada</span>` : '';
      h += `<div class="c ${past ? 'past' : ''} ${rd && rd.conf ? 'conf' : ''} ${hit ? 'hit' : ''}" data-dia="${s}"><div class="d"><span>${dd}/${mm}</span>${badge}</div>${corpo || (past ? '' : '<span class="muted">—</span>')}${marca}</div>`;
    }
    h += '</div>';
    $('cal').innerHTML = h;
    $('cal').querySelectorAll('[data-dia]').forEach(e => e.onclick = () => { if (rotasDoDia(e.dataset.dia)) { diaAtual = e.dataset.dia; irPara('dia'); } });
  }
  let calCliente = null;
  function acharCliente(txt) {
    txt = (txt || '').trim();
    if (!txt) return null;
    const id = txt.split(' — ')[0].trim();
    if (mapCli.has(id)) return id;
    const q = txt.toLowerCase();
    const achados = st.clientes.filter(c => (c.nome + ' ' + (c.razao || '')).toLowerCase().includes(q));
    return achados.length ? (achados.find(c => c.ativo) || achados[0]).id : null;
  }
  $('calBusca').onchange = () => {
    calCliente = acharCliente($('calBusca').value);
    if (!calCliente && $('calBusca').value.trim()) $('calBuscaRes').innerHTML = '<span class="warn">Cliente não encontrado.</span>';
    else renderCalendario();
    const prim = $('cal').querySelector('.hit');
    if (prim) prim.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  $('calLimpar').onclick = () => { $('calBusca').value = ''; calCliente = null; renderCalendario(); };

  // ------------------------------------------------------------------ ROTA DO DIA
  let diaAtual = null, mapaDia = null, camadaDia = null, edicao = null;
  const geomCache = new Map();
  function diasComRota() {
    const s = new Set(Object.keys(st.confirmados));
    if (st.plano) Object.keys(st.plano.dias).forEach(d => { if (d > st.params.hoje) s.add(d); });
    return [...s].sort();
  }
  function renderDia() {
    const ds = diasComRota();
    if (!ds.length) { $('diaRotas').innerHTML = '<span class="muted">Sem rotas. Otimize primeiro.</span>'; return; }
    if (!diaAtual || !ds.includes(diaAtual)) diaAtual = proximoRevisar() && ds.includes(proximoRevisar()) ? proximoRevisar() : ds[0];
    $('diaSel').innerHTML = ds.map(d => `<option value="${d}" ${d === diaAtual ? 'selected' : ''}>${M.fmtCurto(d)}/${d.slice(0, 4)}${st.confirmados[d] ? ' ✓' : ''}</option>`).join('');
    const rd = rotasDoDia(diaAtual);
    const editavel = !rd.conf && diaAtual === proximoRevisar();
    if (editavel && (!edicao || edicao.dia !== diaAtual)) edicao = { dia: diaAtual, rotas: clone(rd.rotas), alterado: false };
    const rotas = editavel ? edicao.rotas : rd.rotas;
    $('diaStatus').innerHTML = rd.conf ? `<span class="tag ok">${diaAtual <= st.params.hoje ? (rd.auto ? 'executada (simulação)' : 'executada') : 'confirmada'}</span>`
      : editavel ? '<span class="tag warn">revisão: ajuste e confirme</span>' : '<span class="tag">planejada (pode mudar nas próximas reotimizações)</span>';

    let h = '';
    rotas.forEach((r, vi) => {
      const v = st.veiculos[veicIdx(r.veiculoId)] || { nome: r.veiculoId, capacidade: 0 };
      const kg = r.clientes.reduce((s, c) => s + (mapCli.get(c)?.kg || 0), 0);
      h += `<h3><span class="dot" style="background:${corV(r.veiculoId)}"></span> ${esc(v.nome)}</h3>
        <div class="small muted">${r.clientes.length} paradas · ${fmtN(r.km, 1)} km · ${fmtH(r.min)} de ${fmtH(st.params.jornadaH * 60)} (com a volta à garagem) · ${fmtN(kg)} de ${fmtN(v.capacidade)} kg · combustível ${fmtR(r.combustivel)}
        ${editavel && edicao.alterado ? ' · <span class="warn">totais serão recalculados ao confirmar</span>' : ''}
        ${r.extraMin > 1 ? ` · <span class="warn">${fmtH(r.extraMin)} além da jornada</span>` : ''}</div>
        <ol class="stops">${r.clientes.map((cid, i) => {
          const c = mapCli.get(cid) || {};
          const ctl = editavel ? `<select data-mv="${vi}:${i}" title="mover para outro veículo">${st.veiculos.map(x => `<option value="${x.id}" ${x.id === r.veiculoId ? 'selected' : ''}>${esc(x.nome.split(' (')[0])}</option>`).join('')}</select>
            <button class="x" data-rm="${vi}:${i}" title="retirar desta rota">✕</button>` : '';
          return `<li><span class="i">${i + 1}</span><span class="nm">${esc(c.nome || cid)}<div class="small muted">${esc(M.FREQ[c.freq]?.nome || '')} · ${c.kg || 0} kg · ${esc(c.cidade || '')}</div></span>${ctl}</li>`;
        }).join('')}</ol>
        ${r.clientes.length ? linksMaps(r) : ''}`;
    });
    if (editavel) {
      h += `<h3>Incluir coleta fora do cronograma</h3><div class="row">
        <input id="dAddCli" list="dlClientes" placeholder="cliente" style="min-width:240px">
        <select id="dAddV">${st.veiculos.map(v => `<option value="${v.id}">${esc(v.nome)}</option>`).join('')}</select>
        <button class="b" id="dAdd">Incluir</button></div>
        <div class="row" style="margin-top:14px"><button class="b p" id="dConf">Confirmar a rota de ${M.fmtCurto(diaAtual)} e reotimizar os próximos dias</button>
        ${edicao.alterado ? '<button class="b" id="dDesf">Descartar alterações</button>' : ''}</div>
        <p class="small muted">A ordem das paradas é otimizada ao confirmar. Clientes retirados voltam a ser programados nos próximos dias;
        clientes incluídos têm a próxima coleta periódica recalculada a partir desta data.</p>`;
    } else if (rd.conf && diaAtual > st.params.hoje && diaAtual === M.ultimoConfirmado(st)) {
      h += `<div class="row" style="margin-top:12px"><button class="b" id="dDesconf">Desfazer confirmação</button></div>`;
    }
    $('diaRotas').innerHTML = h;
    ligarEdicaoDia();
    desenharMapaDia(rotas);
  }
  function linksMaps(r) {
    const g = st.garagem;
    const pts = [[g.lat, g.lng]].concat(r.clientes.map(c => { const x = mapCli.get(c); return [x.lat, x.lng]; })).concat([[g.lat, g.lng]]);
    const partes = [];
    for (let i = 0; i < pts.length - 1; i += 20) partes.push(pts.slice(i, Math.min(pts.length, i + 21)));
    return `<div class="small" style="margin:6px 0 4px">Abrir no Google Maps: ${partes.map((p, k) => `<a target="_blank" rel="noopener" href="https://www.google.com/maps/dir/${p.map(x => x[0].toFixed(6) + ',' + x[1].toFixed(6)).join('/')}">${partes.length > 1 ? 'trecho ' + (k + 1) : 'rota completa'}</a>`).join(' · ')}</div>`;
  }
  function ligarEdicaoDia() {
    const root = $('diaRotas');
    root.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
      const [vi, i] = b.dataset.rm.split(':').map(Number);
      edicao.rotas[vi].clientes.splice(i, 1); edicao.alterado = true; renderDia();
    });
    root.querySelectorAll('[data-mv]').forEach(s => s.onchange = () => {
      const [vi, i] = s.dataset.mv.split(':').map(Number);
      const cid = edicao.rotas[vi].clientes.splice(i, 1)[0];
      const dest = edicao.rotas.find(r => r.veiculoId === s.value);
      dest.clientes.push(cid); edicao.alterado = true; renderDia();
    });
    if ($('dAdd')) $('dAdd').onclick = () => {
      const id = ($('dAddCli').value || '').split(' — ')[0].trim();
      if (!mapCli.has(id)) return alerta('Escolha um cliente da lista.');
      if (edicao.rotas.some(r => r.clientes.includes(id))) return alerta('Este cliente já está na rota do dia.');
      const r = edicao.rotas.find(x => x.veiculoId === $('dAddV').value);
      r.clientes.push(id); edicao.alterado = true; renderDia();
    };
    if ($('dDesf')) $('dDesf').onclick = () => { edicao = null; renderDia(); };
    if ($('dConf')) $('dConf').onclick = confirmarDia;
    if ($('dDesconf')) $('dDesconf').onclick = desfazerConfirmacao;
  }

  function problemaSequencia() {
    const prob = M.montarProblema(st, matriz);
    const P = prob.P;
    return { prob, Pmin: { n: P.n, dist: P.dist, time: P.time, V: P.V, vehicles: P.vehicles, params: P.params, avail: new Uint8Array(P.V).fill(1), dayNum: new Int32Array(1) } };
  }

  async function confirmarDia() {
    const dia = edicao.dia;
    const { prob, Pmin } = problemaSequencia();
    const rotas = [];
    for (const r of edicao.rotas) {
      const vi = veicIdx(r.veiculoId), v = st.veiculos[vi];
      const cs = r.clientes.filter(c => prob.locOf.has(c));
      let seq = { order: [], km: 0, min: 0, load: 0 };
      if (cs.length) seq = await chamar('sequence', { problem: Pmin, locs: cs.map(c => prob.locOf.get(c)), dems: cs.map(c => mapCli.get(c).kg), svcs: cs.map(c => M.servicoDe(mapCli.get(c), st.params)), v: vi });
      rotas.push({ veiculoId: r.veiculoId, clientes: seq.order.map(t => cs[t]), km: seq.km, min: seq.min, kg: seq.load,
        combustivel: seq.km * M.precoComb(v, st.params) / v.consumo, extraMin: Math.max(0, seq.min - st.params.jornadaH * 60), extraKg: Math.max(0, seq.load - v.capacidade) });
    }
    registrarConfirmacao(dia, rotas, false);
    edicao = null;
    salvar();
    await otimizar('quente', `Rota de ${M.fmtCurto(dia)} confirmada`);
    diaAtual = dia; irPara('dia');
  }

  function registrarConfirmacao(dia, rotas, auto) {
    const anteriores = {};
    for (const r of rotas) for (const cid of r.clientes) {
      const c = mapCli.get(cid);
      if (!c) continue;
      anteriores[cid] = { ultimaColeta: c.ultimaColeta, inicio: c.inicio };
      if (c.freq !== 'demanda') { c.ultimaColeta = dia; c.inicio = null; }
      const av = st.avulsas.find(a => a.clienteId === cid && a.status !== 'feita' && a.de <= dia);
      if (av) { av.status = 'feita'; av.feitaEm = dia; anteriores[cid].avulsa = av.id; }
    }
    st.confirmados[dia] = { rotas, confirmadoEm: new Date().toISOString(), auto, anteriores };
  }

  function desfazerConfirmacao() {
    const dia = diaAtual, cf = st.confirmados[dia];
    if (!cf || !confirm(`Desfazer a confirmação de ${M.fmtCurto(dia)}?`)) return;
    for (const [cid, a] of Object.entries(cf.anteriores || {})) {
      const c = mapCli.get(cid); if (!c) continue;
      c.ultimaColeta = a.ultimaColeta; c.inicio = a.inicio;
      if (a.avulsa) { const av = st.avulsas.find(x => x.id === a.avulsa); if (av) { av.status = 'pendente'; delete av.feitaEm; } }
    }
    if (st.plano) st.plano.dias[dia] = cf.rotas;
    delete st.confirmados[dia];
    marcarDesatualizado(); renderDia();
  }

  function desenharMapaDia(rotas) {
    if (!mapaDia) {
      mapaDia = L.map('mapaDia');
      camadaBase().addTo(mapaDia);
      camadaDia = L.layerGroup().addTo(mapaDia);
    }
    setTimeout(() => mapaDia.invalidateSize(), 50);
    camadaDia.clearLayers();
    const g = st.garagem;
    const bounds = [[g.lat, g.lng]];
    L.marker([g.lat, g.lng], { title: 'Garagem' }).bindPopup('<b>Garagem</b><br>' + esc(g.endereco)).addTo(camadaDia);
    let usouRuas = false;
    rotas.forEach(r => {
      if (!r.clientes.length) return;
      const cor = corV(r.veiculoId);
      const pts = [[g.lat, g.lng]];
      r.clientes.forEach((cid, i) => {
        const c = mapCli.get(cid); if (!c) return;
        pts.push([c.lat, c.lng]); bounds.push([c.lat, c.lng]);
        L.marker([c.lat, c.lng], { icon: L.divIcon({ className: '', html: `<div class="num-icon" style="border-color:${cor}">${i + 1}</div>`, iconSize: [20, 20], iconAnchor: [10, 10] }) })
          .bindPopup(`<b>${i + 1}. ${esc(c.nome)}</b><br>${esc(c.endereco)}<br>${esc(M.FREQ[c.freq]?.nome)} · ${c.kg} kg`).addTo(camadaDia);
      });
      pts.push([g.lat, g.lng]);
      const key = diaAtual + '|' + r.veiculoId + '|' + r.clientes.join(',');
      if (geomCache.has(key)) { L.polyline(geomCache.get(key), { color: cor, weight: 4, opacity: .8 }).addTo(camadaDia); usouRuas = true; }
      else L.polyline(pts, { color: cor, weight: 3, opacity: .75, dashArray: '6 6' }).addTo(camadaDia);
    });
    if (bounds.length > 1) mapaDia.fitBounds(bounds, { padding: [20, 20] }); else mapaDia.setView([g.lat, g.lng], 13);
    $('mapaNota').textContent = usouRuas ? 'Trajeto pelas ruas (OSRM).' : 'Linhas tracejadas ligam as paradas em sequência (não é o trajeto exato). Use "Traçar pelas ruas" para ver o percurso real.';
  }
  $('diaSel').onchange = () => { diaAtual = $('diaSel').value; renderDia(); };
  $('diaAnt').onclick = () => { const ds = diasComRota(); const i = ds.indexOf(diaAtual); if (i > 0) { diaAtual = ds[i - 1]; renderDia(); } };
  $('diaProx').onclick = () => { const ds = diasComRota(); const i = ds.indexOf(diaAtual); if (i < ds.length - 1) { diaAtual = ds[i + 1]; renderDia(); } };
  $('btnRuas').onclick = async () => {
    const rd = rotasDoDia(diaAtual); if (!rd) return;
    const rotas = edicao && edicao.dia === diaAtual ? edicao.rotas : rd.rotas;
    const g = st.garagem;
    $('btnRuas').disabled = true; $('mapaNota').textContent = 'Consultando o OSRM…';
    try {
      for (const r of rotas) {
        if (!r.clientes.length) continue;
        const pts = [[g.lat, g.lng]].concat(r.clientes.map(c => [mapCli.get(c).lat, mapCli.get(c).lng])).concat([[g.lat, g.lng]]);
        const geo = await A.geometriaRota(pts);
        geomCache.set(diaAtual + '|' + r.veiculoId + '|' + r.clientes.join(','), geo.linha);
      }
    } catch (e) { alerta('Não foi possível consultar o OSRM: ' + e.message); }
    $('btnRuas').disabled = false;
    renderDia();
  };

  // ------------------------------------------------------------------ avançar dia (simulação)
  $('btnAvancar').onclick = () => {
    const cal = M.calendario(st);
    const novo = M.dstr(M.dnum(st.params.hoje) + 1);
    if (cal.diaUtilFrota(novo) && !st.confirmados[novo]) {
      const rd = rotasDoDia(novo);
      if (rd && !confirm(`A rota de ${M.fmtCurto(novo)} ainda não foi confirmada. Considerar que ela foi executada como planejada?`)) return;
      if (rd) registrarConfirmacao(novo, clone(rd.rotas), true);
    }
    st.params.hoje = novo;
    edicao = null;
    salvar(); renderTudo();
  };

  // ------------------------------------------------------------------ CLIENTES
  Object.entries(M.FREQ).forEach(([k, f]) => { $('cliFreq').insertAdjacentHTML('beforeend', `<option value="${k}">${f.nome}</option>`); $('nvFreq').insertAdjacentHTML('beforeend', `<option value="${k}" ${k === 'mensal' ? 'selected' : ''}>${f.nome}</option>`); });
  ['cliBusca', 'cliFreq', 'cliTipo', 'cliSit'].forEach(id => $(id).oninput = renderClientes);
  const GEO_RUIM = ['cidade', 'falhou', 'bairro', null, undefined];
  function geoTxt(c) {
    if (!M.temCoord(c)) return '<span class="bad" title="sem localização: não entra nas rotas">sem local</span>';
    if (!c.geoPrecisao) return '';
    const cls = { numero: 'ok', rua: 'muted', cep: 'warn', bairro: 'warn', cidade: 'bad', manual: 'ok' }[c.geoPrecisao] || 'muted';
    return `<span class="${cls}" title="precisão da localização">${c.geoPrecisao}</span>`;
  }
  function renderClientes() {
    const q = $('cliBusca').value.trim().toLowerCase(), fq = $('cliFreq').value, tp = $('cliTipo').value, si = $('cliSit').value;
    const prox = proximasDatas();
    const lista = st.clientes.filter(c => (!q || (c.id + ' ' + c.nome + ' ' + c.cidade + ' ' + (c.razao || '')).toLowerCase().includes(q)) && (!fq || c.freq === fq) && (!tp || c.tipo === tp)
      && (!si || (si === 'ativos' && c.ativo) || (si === 'inativos' && !c.ativo) || (si === 'geo' && c.ativo && (!M.temCoord(c) || (c.origem && GEO_RUIM.includes(c.geoPrecisao))))));
    const nAt = st.clientes.filter(c => c.ativo).length;
    $('cliCont').textContent = `${lista.length} exibidos · ${nAt} ativos · ${st.clientes.length - nAt} inativos`;
    $('cliTab').innerHTML = `<tr><th>Código</th><th>Nome</th><th>Cidade</th><th>Frequência</th><th class="n">kg</th><th>Última coleta</th><th>Próximas (plano)</th><th>Local</th><th></th></tr>` +
      lista.slice(0, 600).map(c => `<tr style="${c.ativo ? '' : 'opacity:.6'}"><td>${esc(c.id)}</td><td>${esc(c.nome)}${!c.ativo && c.motivoInativo ? `<div class="small muted">${esc(c.motivoInativo)}</div>` : ''}</td><td>${esc(c.cidade)}</td>
        <td>${esc(M.FREQ[c.freq]?.nome)}${c.tol !== null && c.tol !== '' && c.tol !== undefined ? ` (±${c.tol})` : ''}</td><td class="n">${fmtN(c.kg, 1)}</td>
        <td>${c.ultimaColeta ? M.fmtData(c.ultimaColeta) : (c.inicio ? 'início ' + M.fmtData(c.inicio) : '—')}</td>
        <td class="small">${(prox.get(c.id) || []).slice(0, 3).map(M.fmtCurto).join(', ') || '—'}</td>
        <td class="small">${geoTxt(c)}</td>
        <td style="white-space:nowrap"><button class="b" data-ed="${esc(c.id)}">editar</button> <button class="b" data-at="${esc(c.id)}">${c.ativo ? 'inativar' : 'reativar'}</button></td></tr>`).join('');
    $('cliTab').querySelectorAll('[data-ed]').forEach(b => b.onclick = () => editarCliente(b.dataset.ed));
    $('cliTab').querySelectorAll('[data-at]').forEach(b => b.onclick = () => {
      const c = mapCli.get(b.dataset.at);
      c.ativo = !c.ativo; c.ativoManual = c.ativo; c.motivoInativo = c.ativo ? '' : 'Inativado manualmente';
      marcarDesatualizado(); renderClientes(); renderCabecalho();
    });
  }
  let mapaEd = null;
  function editarCliente(id) {
    if (mapaEd) { try { mapaEd.remove(); } catch (e) { /* já removido */ } mapaEd = null; }
    const c = mapCli.get(id), box = $('cliEdit');
    box.style.display = '';
    box.innerHTML = `<h2>Editar ${esc(c.id)}</h2><div class="row">
      <label class="f">Nome<input id="ceNome" value="${esc(c.nome)}" style="min-width:260px"></label>
      <label class="f">Cidade<input id="ceCid" value="${esc(c.cidade)}"></label>
      <label class="f">Tipo<select id="ceTipo"><option value="saude" ${c.tipo === 'saude' ? 'selected' : ''}>saúde</option><option value="industrial" ${c.tipo === 'industrial' ? 'selected' : ''}>industrial</option></select></label>
      <label class="f">Frequência<select id="ceFreq">${Object.entries(M.FREQ).map(([k, f]) => `<option value="${k}" ${k === c.freq ? 'selected' : ''}>${f.nome}</option>`).join('')}</select></label>
      <label class="f">Tolerância ± dias<input id="ceTol" type="number" min="0" value="${c.tol === null || c.tol === undefined ? '' : c.tol}" placeholder="padrão ${M.FREQ[c.freq]?.tol}" style="width:90px"></label>
      <label class="f">kg/coleta<input id="ceKg" type="number" value="${c.kg}" style="width:90px"></label>
      <label class="f">Tempo de parada (min)<input id="ceSvc" type="number" step="any" value="${c.servico === null || c.servico === undefined ? '' : c.servico}" placeholder="padrão ${st.params.tempoParada}" style="width:110px"></label>
      <label class="f">Última coleta<input id="ceUlt" type="date" value="${c.ultimaColeta || ''}"></label>
      <label class="f">Latitude<input id="ceLat" value="${c.lat}" style="width:110px"></label>
      <label class="f">Longitude<input id="ceLng" value="${c.lng}" style="width:110px"></label>
      <label class="f">Ativo<input id="ceAtivo" type="checkbox" ${c.ativo ? 'checked' : ''}></label>
      </div>
      <div class="small muted" style="margin-top:6px">${esc(c.endereco || '')}${c.contrato ? ' · contrato: ' + esc(c.contrato) : ''}${c.geoPrecisao ? ' · localização: ' + esc(c.geoPrecisao) : ''}</div>
      <div id="ceMapa" class="map" style="height:300px;margin-top:8px"></div>
      <div class="small muted">Clique no mapa ou arraste o marcador para corrigir a localização.</div>
      <div class="row" style="margin-top:10px"><button class="b p" id="ceSalvar">Salvar</button><button class="b" id="ceFechar">Fechar</button></div>`;
    let movido = false;
    const temC = M.temCoord(c);
    const centro = temC ? [c.lat, c.lng] : [st.garagem.lat, st.garagem.lng];
    const mp = mapaEd = L.map('ceMapa').setView(centro, temC ? 16 : 12);
    camadaBase().addTo(mp);
    const mk = L.marker(centro, { draggable: true }).addTo(mp);
    const setP = (p) => { $('ceLat').value = p.lat.toFixed(6); $('ceLng').value = p.lng.toFixed(6); movido = true; };
    mk.on('dragend', e => setP(e.target.getLatLng()));
    mp.on('click', e => { mk.setLatLng(e.latlng); setP(e.latlng); });
    $('ceFechar').onclick = () => { mp.remove(); box.style.display = 'none'; };
    $('ceSalvar').onclick = () => {
      c.nome = $('ceNome').value; c.cidade = $('ceCid').value; c.tipo = $('ceTipo').value; c.freq = $('ceFreq').value;
      c.tol = $('ceTol').value === '' ? null : Number($('ceTol').value); c.kg = Number($('ceKg').value); c.servico = $('ceSvc').value === '' ? null : Number($('ceSvc').value);
      c.ultimaColeta = $('ceUlt').value || null;
      const la = parseFloat($('ceLat').value), ln = parseFloat($('ceLng').value);
      if (isFinite(la) && isFinite(ln) && (movido || la !== c.lat || ln !== c.lng)) { c.lat = la; c.lng = ln; c.geoPrecisao = 'manual'; }
      if (c.ativo !== $('ceAtivo').checked) { c.ativo = $('ceAtivo').checked; c.ativoManual = c.ativo; c.motivoInativo = c.ativo ? '' : 'Inativado manualmente'; }
      mp.remove(); box.style.display = 'none'; idxCli(); marcarDesatualizado(); renderClientes(); renderCabecalho();
    };
    box.scrollIntoView({ behavior: 'smooth' });
  }

  // ------------------------------------------------------------------ NOVO CLIENTE
  let mapaNovo = null, marcaNovo = null;
  function renderNovo() {
    if (!mapaNovo) {
      mapaNovo = L.map('mapaNovo').setView([st.garagem.lat, st.garagem.lng], 13);
      camadaBase().addTo(mapaNovo);
      L.marker([st.garagem.lat, st.garagem.lng], { title: 'Garagem' }).addTo(mapaNovo);
      st.clientes.filter(c => c.ativo).forEach(c => L.circleMarker([c.lat, c.lng], { radius: 3, color: '#888', weight: 1, fillOpacity: .5 }).bindTooltip(c.nome).addTo(mapaNovo));
      mapaNovo.on('click', (e) => { $('nvLat').value = e.latlng.lat.toFixed(6); $('nvLng').value = e.latlng.lng.toFixed(6); posMarcaNovo(); });
    }
    setTimeout(() => mapaNovo.invalidateSize(), 50);
  }
  function posMarcaNovo() {
    const lat = Number($('nvLat').value), lng = Number($('nvLng').value);
    if (!isFinite(lat) || !isFinite(lng) || !lat) return;
    if (!marcaNovo) marcaNovo = L.marker([lat, lng], { draggable: true }).addTo(mapaNovo).on('dragend', (e) => { const p = e.target.getLatLng(); $('nvLat').value = p.lat.toFixed(6); $('nvLng').value = p.lng.toFixed(6); });
    else marcaNovo.setLatLng([lat, lng]);
  }
  $('nvLat').onchange = $('nvLng').onchange = posMarcaNovo;
  $('nvGeo').onclick = async () => {
    const q = `${$('nvEnd').value}, ${$('nvCidade').value}, MG`;
    try {
      const r = await A.geocodificar(q);
      if (!r) return alerta('Endereço não encontrado. Marque o local clicando no mapa.');
      $('nvLat').value = r.lat.toFixed(6); $('nvLng').value = r.lng.toFixed(6); posMarcaNovo(); mapaNovo.setView([r.lat, r.lng], 16);
    } catch (e) { alerta('Falha na busca do endereço: ' + e.message); }
  };

  function lerNovo() {
    const c = {
      id: novoId(), nome: $('nvNome').value.trim() || 'Novo cliente', endereco: $('nvEnd').value.trim(), cidade: $('nvCidade').value.trim() || st.params.cidadeBase,
      tipo: $('nvTipo').value, freq: $('nvFreq').value, tol: $('nvTol').value === '' ? null : Number($('nvTol').value),
      kg: Number($('nvKg').value) || 0, servico: $('nvSvc').value === '' ? null : Number($('nvSvc').value), lat: Number($('nvLat').value), lng: Number($('nvLng').value),
      ultimaColeta: null, inicio: null, ativo: true,
    };
    if (!isFinite(c.lat) || !isFinite(c.lng) || !c.lat || !c.lng) return null;
    return c;
  }
  function novoId() { let k = st.clientes.length + 1; while (mapCli.has('C' + String(k).padStart(4, '0'))) k++; return 'C' + String(k).padStart(4, '0'); }

  function candidatos(c, prob) {
    const cal = M.calendario(st);
    const ok = (s) => cal.diaUtilCliente(s, c.cidade);
    const dias = prob.dias, idx = new Map(dias.map((d, i) => [d, i]));
    const out = [];
    if (c.freq === '2x') {
      M.PADROES_2X.forEach(pad => {
        const ds = dias.map((d, i) => [d, i]).filter(([d]) => pad.includes(M.wday(M.dnum(d))) && ok(d)).map(x => x[1]);
        out.push({ rotulo: pad.map(w => M.DIAS_SEM[w]).join(' e '), inicio: null, days: ds });
      });
    } else if (c.freq === 'demanda') {
      dias.slice(0, 15).forEach((d, i) => { if (ok(d)) out.push({ rotulo: `Coleta em ${M.fmtCurto(d)}`, inicio: d, days: [i] }); });
    } else {
      const f = M.FREQ[c.freq], I = f.intervalo, tol = c.tol !== null ? c.tol : f.tol;
      const fim = M.dnum(dias[dias.length - 1]);
      const starts = dias.filter(ok).slice(0, Math.min(Math.round(I), 25));
      for (const s of starts) {
        const ds = [];
        for (let k = 0; M.dnum(s) + k * I <= fim; k++) {
          const alvo = Math.round(M.dnum(s) + k * I);
          let achou = -1;
          for (let e = 0; e <= Math.max(tol, 3) && achou < 0; e++) for (const sg of e ? [1, -1] : [0]) {
            const x = M.dstr(alvo + sg * e);
            if (achou < 0 && ok(x) && idx.has(x) && (k === 0 ? x === s : true)) achou = idx.get(x);
          }
          if (achou >= 0) ds.push(achou);
        }
        out.push({ rotulo: `Início em ${M.fmtCurto(s)}`, inicio: s, days: ds });
      }
    }
    return out.filter(x => x.days.length);
  }

  $('nvSugerir').onclick = async () => {
    const c = lerNovo();
    if (!c) return alerta('Informe a localização (lat/lng) ou clique no mapa.');
    if (!st.plano) return alerta('Gere um plano antes (Início → Otimizar).');
    const tmp = Object.assign({}, st, { clientes: st.clientes.concat([Object.assign({}, c, { freq: 'demanda' })]) });
    const prob = M.montarProblema(tmp, matriz);
    const loc = prob.locOf.get(c.id);
    const allowedV = st.veiculos.map(v => (v.tipos || []).includes(c.tipo) ? 1 : 0);
    const cands = candidatos(c, prob);
    $('nvRes').innerHTML = '<span class="muted">Calculando…</span>';
    const t0 = performance.now();
    const res = await chamar('evaluate', { problem: prob.P, candidates: cands.map(k => ({ loc, dem: c.kg, svc: M.servicoDe(c, st.params), allowedV, days: k.days })) });
    const ms = performance.now() - t0;
    const lst = cands.map((k, i) => Object.assign({}, k, res[i])).filter(x => x.ok);
    lst.sort((a, b) => a.cost / a.days.length - b.cost / b.days.length);
    const top = lst.slice(0, 5);
    const vizinho = (t) => t >= 0 ? esc(nomeCli(prob.meta[t].clienteId)) : 'garagem';
    $('nvRes').innerHTML = `<h3>Melhores encaixes (${top.length} de ${lst.length} opções avaliadas em ${(ms / 1000).toFixed(1)} s)</h3>
      <table><tr><th>Opção</th><th class="n">Visitas no horizonte</th><th class="n">km extra</th><th class="n">Custo extra/visita</th><th>1ª coleta</th><th></th></tr>
      ${top.map((x, i) => {
        const w = x.where[0];
        const vn = st.veiculos[w.v]?.nome || '';
        return `<tr><td>${esc(x.rotulo)}</td><td class="n">${x.days.length}</td><td class="n">${fmtN(x.km, 1)}</td><td class="n">${fmtR(x.cost / x.days.length)}</td>
        <td class="small">${M.fmtCurto(prob.dias[w.d])}, ${esc(vn)}, entre ${vizinho(w.prevTask)} e ${vizinho(w.nextTask)}</td>
        <td><button class="b p" data-esc="${i}">Cadastrar</button></td></tr>`;
      }).join('')}</table>
      <p class="small muted">Custo extra = combustível adicional (mais penalidades de jornada/capacidade, se houver) para encaixar o cliente no plano atual, sem mexer nos demais.
      Depois do cadastro, a reotimização pode melhorar ainda mais o encaixe.</p>`;
    $('nvRes').querySelectorAll('[data-esc]').forEach(b => b.onclick = async () => {
      const x = top[Number(b.dataset.esc)];
      if (c.freq === 'demanda') { st.avulsas.push({ id: 'A' + Date.now(), clienteId: c.id, de: x.inicio, ate: x.inicio, status: 'pendente' }); }
      else if (x.inicio) c.inicio = x.inicio;
      st.clientes.push(c); idxCli();
      salvar();
      $('nvRes').innerHTML = `<span class="ok">Cliente ${esc(c.id)} cadastrado.</span>`;
      ['nvNome', 'nvEnd', 'nvLat', 'nvLng', 'nvTol'].forEach(id => $(id).value = '');
      if (marcaNovo) { mapaNovo.removeLayer(marcaNovo); marcaNovo = null; }
      L.circleMarker([c.lat, c.lng], { radius: 3, color: '#888', weight: 1 }).bindTooltip(c.nome).addTo(mapaNovo);
      await otimizar('quente', `Novo cliente ${c.nome}`);
    });
  };

  // ------------------------------------------------------------------ FROTA
  function renderFrota() {
    $('frotaTab').innerHTML = `<table><tr><th>Nome</th><th>Placa</th><th class="n">Capacidade (kg)</th><th class="n">Consumo (km/L)</th><th>Combustível</th><th>Resíduos</th><th></th></tr>
      ${st.veiculos.map((v, i) => `<tr>
        <td><input data-vf="${i}:nome" value="${esc(v.nome)}"></td><td><input data-vf="${i}:placa" value="${esc(v.placa)}" style="width:100px"></td>
        <td class="n"><input data-vf="${i}:capacidade" type="number" value="${v.capacidade}" style="width:90px"></td>
        <td class="n"><input data-vf="${i}:consumo" type="number" step="0.1" value="${v.consumo}" style="width:80px"></td>
        <td><select data-vf="${i}:combustivel"><option value="gasolina" ${v.combustivel !== 'diesel' ? 'selected' : ''}>gasolina</option><option value="diesel" ${v.combustivel === 'diesel' ? 'selected' : ''}>diesel</option></select></td>
        <td><label><input type="checkbox" data-vt="${i}:saude" ${v.tipos.includes('saude') ? 'checked' : ''}> saúde</label>
            <label><input type="checkbox" data-vt="${i}:industrial" ${v.tipos.includes('industrial') ? 'checked' : ''}> industrial</label></td>
        <td>${st.veiculos.length > 1 ? `<button class="x" data-vr="${i}" title="remover">✕</button>` : ''}</td></tr>`).join('')}</table>
      <p class="small muted">O custo por km de cada veículo é o preço do seu combustível (gasolina ou diesel, em Configurações) ÷ consumo. A jornada máxima diária também fica em Configurações. Com consumos diferentes, o otimizador prefere o veículo mais econômico enquanto houver capacidade e jornada.</p>`;
    $('frotaTab').querySelectorAll('[data-vf]').forEach(e => e.onchange = () => {
      const [i, k] = e.dataset.vf.split(':'); const v = st.veiculos[i];
      v[k] = e.type === 'number' ? Number(e.value) : e.value; marcarDesatualizado();
    });
    $('frotaTab').querySelectorAll('[data-vt]').forEach(e => e.onchange = () => {
      const [i, k] = e.dataset.vt.split(':'); const v = st.veiculos[i];
      v.tipos = v.tipos.filter(x => x !== k); if (e.checked) v.tipos.push(k); marcarDesatualizado();
    });
    $('frotaTab').querySelectorAll('[data-vr]').forEach(e => e.onclick = () => {
      if (!confirm('Remover o veículo?')) return;
      const v = st.veiculos.splice(Number(e.dataset.vr), 1)[0];
      st.indisponibilidades = st.indisponibilidades.filter(x => x.veiculoId !== v.id);
      st.plano = null; salvar(); renderTudo();
    });
    $('indVeic').innerHTML = st.veiculos.map(v => `<option value="${v.id}">${esc(v.nome)}</option>`).join('');
    if (!$('indDe').value) { const pr = proximoRevisar() || st.params.hoje; $('indDe').value = pr; $('indAte').value = pr; }
    $('indLista').innerHTML = st.indisponibilidades.length ? `<table><tr><th>Veículo</th><th>De</th><th>Até</th><th>Motivo</th><th></th></tr>${st.indisponibilidades.map((x, i) => `<tr><td>${esc(st.veiculos[veicIdx(x.veiculoId)]?.nome || x.veiculoId)}</td><td>${M.fmtData(x.de)}</td><td>${M.fmtData(x.ate)}</td><td>${esc(x.motivo)}</td><td><button class="x" data-ir="${i}">✕</button></td></tr>`).join('')}</table>` : '<span class="muted">Nenhum registro.</span>';
    $('indLista').querySelectorAll('[data-ir]').forEach(b => b.onclick = () => { st.indisponibilidades.splice(Number(b.dataset.ir), 1); marcarDesatualizado(); renderFrota(); });
  }
  $('addVeic').onclick = () => {
    const k = st.veiculos.length + 1;
    let id = 'v' + k; while (st.veiculos.some(v => v.id === id)) id += 'b';
    st.veiculos.push({ id, nome: `Veículo ${k}`, placa: '', capacidade: 1000, consumo: 8, combustivel: 'gasolina', tipos: ['saude', 'industrial'] });
    st.plano = null; salvar(); renderTudo();
  };
  $('indAdd').onclick = async () => {
    const de = $('indDe').value, ate = $('indAte').value || de;
    if (!de || ate < de) return alerta('Informe o período.');
    const vid = $('indVeic').value;
    if (st.confirmados[de]) alerta('Atenção: a rota deste dia já estava confirmada. As rotas confirmadas não são alteradas; desfaça a confirmação se precisar replanejar este dia.');
    st.indisponibilidades.push({ veiculoId: vid, de, ate, motivo: $('indMot').value });
    salvar(); renderFrota();
    await otimizar('quente', `${st.veiculos[veicIdx(vid)].nome} inoperante de ${M.fmtData(de)} a ${M.fmtData(ate)}`);
  };

  // ------------------------------------------------------------------ AVULSAS
  function renderAvulsas() {
    if (!$('avDe').value) { const pr = proximoRevisar() || st.params.hoje; $('avDe').value = pr; $('avAte').value = M.dstr(M.dnum(pr) + 5); }
    const prox = proximasDatas();
    $('avLista').innerHTML = st.avulsas.length ? `<table><tr><th>Cliente</th><th>Janela</th><th>Situação</th><th></th></tr>${st.avulsas.slice().reverse().map(a => {
      const i = st.avulsas.indexOf(a);
      const pl = (prox.get(a.clienteId) || []).find(d => d >= a.de && d <= a.ate);
      const sit = a.status === 'feita' ? `<span class="ok">feita em ${M.fmtData(a.feitaEm)}</span>` : pl ? `programada para ${M.fmtCurto(pl)}` : '<span class="warn">aguardando otimização</span>';
      return `<tr><td>${esc(nomeCli(a.clienteId))}</td><td>${M.fmtData(a.de)} a ${M.fmtData(a.ate)}</td><td>${sit}</td><td>${a.status !== 'feita' ? `<button class="x" data-ar="${i}">✕</button>` : ''}</td></tr>`;
    }).join('')}</table>` : '<span class="muted">Nenhuma coleta avulsa.</span>';
    $('avLista').querySelectorAll('[data-ar]').forEach(b => b.onclick = () => { st.avulsas.splice(Number(b.dataset.ar), 1); marcarDesatualizado(); renderAvulsas(); });
  }
  $('avAdd').onclick = async () => {
    const id = ($('avCli').value || '').split(' — ')[0].trim();
    if (!mapCli.has(id)) return alerta('Escolha um cliente da lista.');
    const de = $('avDe').value, ate = $('avAte').value || de;
    if (!de || ate < de) return alerta('Informe a janela.');
    st.avulsas.push({ id: 'A' + Date.now(), clienteId: id, de, ate, kg: $('avKg').value ? Number($('avKg').value) : null, status: 'pendente' });
    $('avCli').value = '';
    salvar(); renderAvulsas();
    await otimizar('quente', `Coleta avulsa: ${nomeCli(id)}`);
  };

  // ------------------------------------------------------------------ CONFIGURAÇÕES
  const CAMPOS = [
    ['hoje', 'Data de hoje (simulação)', 'date'], ['cidadeBase', 'Cidade-base da frota', 'text'], ['horizonte', 'Horizonte de planejamento (dias corridos)', 'number'],
    ['sabado', 'Trabalha aos sábados', 'checkbox'], ['precoGasolina', 'Preço da gasolina (R$/L)', 'number'], ['precoDiesel', 'Preço do diesel (R$/L)', 'number'],
    ['jornadaH', 'Jornada máxima por dia, incluindo a volta à garagem (h)', 'number'],
    ['jornadaAlvoH', 'Jornada-alvo (h): acima dela o otimizador tenta dividir o trabalho entre os veículos', 'number'],
    ['Pfolga', 'Custo por minuto acima da jornada-alvo (R$) — maior = mais equilíbrio entre veículos', 'number'], ['tempoGaragem', 'Tempo na garagem por rota, se contar na jornada (min)', 'number'],
    ['tempoParada', 'Tempo médio por parada (min) — clientes podem ter valor próprio', 'number'],
    ['velUrbana', 'Velocidade média entre paradas, até 10 km (km/h)', 'number'], ['velRodovia', 'Velocidade média em trechos longos, acima de 10 km (km/h)', 'number'],
    ['fatorDesvio', 'Fator de desvio da estimativa sem matriz das ruas (linha reta → ruas)', 'number'],
    ['aviso', 'Dias úteis "congelados" para mudanças (aviso ao cliente)', 'number'], ['penMudancaProx', 'Penalidade por mudar a data dentro desse prazo (R$)', 'number'],
    ['penMudancaLonge', 'Penalidade por mudar a data depois desse prazo (R$)', 'number'], ['Ptime', 'Penalidade por minuto além da jornada (R$) — alta = jornada rígida', 'number'],
    ['Pcap', 'Penalidade por kg acima da capacidade (R$)', 'number'], ['Pgap', 'Penalidade por dia fora do intervalo entre coletas (R$)', 'number'],
    ['Patraso', 'Penalidade por dia útil de atraso além da tolerância (R$)', 'number'], ['atrasoMax', 'Atraso máximo permitido (dias úteis)', 'number'],
    ['Pun', 'Penalidade por visita não programada (R$)', 'number'], ['tempoDiario', 'Tempo da reotimização diária (s)', 'number'], ['tempoCompleto', 'Tempo da otimização do zero (s)', 'number'],
  ];
  function renderConfig() {
    const p = st.params;
    $('cfgParams').innerHTML = `<div class="grid" style="grid-template-columns:1fr 1fr;gap:8px">${CAMPOS.map(([k, l, t]) =>
      `<label class="f">${l}<input data-cf="${k}" type="${t}" ${t === 'checkbox' ? (p[k] ? 'checked' : '') : `value="${esc(p[k])}"`} ${t === 'number' ? 'step="any"' : ''}></label>`).join('')}</div>
      <p class="small muted">Tolerâncias padrão: semanal ±1, quinzenal ±2, mensal ±4, bimestral ±6 dias (ajustáveis por cliente). 2x/semana usa seg+qui ou ter+sex.
      Garagem: ${esc(st.garagem.endereco)} (${st.garagem.lat}, ${st.garagem.lng}).</p>`;
    $('ferTab').innerHTML = `<tr><th>Data</th><th>Nome</th><th>Cidade</th><th></th></tr>` + st.feriados.map((f, i) => `<tr><td>${M.fmtCurto(f.data)}/${f.data.slice(0, 4)}</td><td>${esc(f.nome)}</td><td>${esc(f.cidade || 'nacional')}</td><td><button class="x" data-fr="${i}">✕</button></td></tr>`).join('');
    $('ferTab').querySelectorAll('[data-fr]').forEach(b => b.onclick = () => { st.feriados.splice(Number(b.dataset.fr), 1); marcarDesatualizado(); renderConfig(); });
    renderDistInfo();
    renderSync();
  }
  $('cfgSalvar').onclick = () => {
    document.querySelectorAll('[data-cf]').forEach(e => { const k = e.dataset.cf; st.params[k] = e.type === 'checkbox' ? e.checked : e.type === 'number' ? Number(e.value) : e.value; });
    marcarDesatualizado(); renderCabecalho(); alerta('Parâmetros salvos.');
  };
  $('ferAdd').onclick = () => {
    if (!$('ferData').value) return;
    st.feriados.push({ data: $('ferData').value, nome: $('ferNome').value || 'Feriado', cidade: $('ferCid').value.trim() });
    st.feriados.sort((a, b) => a.data.localeCompare(b.data)); marcarDesatualizado(); renderConfig();
  };

  function renderDistInfo() {
    const ativos = st.clientes.filter(c => c.ativo).length + 1;
    let txt;
    if (!matriz) txt = `Usando <b>estimativa</b>: distância em linha reta × ${st.params.fatorDesvio}, velocidade média conforme a distância. Bom para testes; para o uso real, calcule pelas ruas.`;
    else {
      const ix = new Set(matriz.ids);
      const falt = st.clientes.filter(c => c.ativo && !ix.has(c.id)).length;
      txt = `Matriz <b>pelas ruas (OSRM)</b> com ${matriz.ids.length} locais, calculada em ${new Date(matriz.geradoEm).toLocaleString('pt-BR')}.` + (falt ? ` <span class="warn">${falt} cliente(s) novo(s) ainda com estimativa — clique para completar (só as linhas novas são consultadas).</span>` : '');
    }
    $('distInfo').innerHTML = `<p class="small">${txt}</p><p class="small muted">${ativos} locais → ${fmtN(ativos * ativos)} pares. Pelo servidor público do OSRM leva cerca de ${Math.ceil(Math.ceil(ativos / 50) ** 2 * 1.4 / 60)} min na primeira vez (blocos de 50×50) e fica gravado neste navegador. Clientes novos exigem só a consulta das suas linhas.</p>`;
  }
  $('distCalc').onclick = async () => {
    const prob = M.montarProblema(st, null);
    $('distCalc').disabled = true; $('distBar').style.display = '';
    try {
      const m = await A.calcularMatriz(prob.ids, prob.P.coords, matriz, (k, t) => { $('distBar').firstElementChild.style.width = (100 * k / t) + '%'; $('distProg').textContent = `Bloco ${k} de ${t}`; });
      matriz = m;
      if (!A.Local.salvarMatriz(m)) alerta('A matriz foi calculada mas não coube no armazenamento do navegador; ela será usada só nesta sessão.');
      $('distProg').textContent = 'Concluído.';
      marcarDesatualizado();
    } catch (e) { alerta('Falha ao consultar o OSRM: ' + e.message + '. Tente novamente mais tarde; o servidor público pode estar ocupado.'); }
    $('distCalc').disabled = false; renderDistInfo();
  };
  $('distLimpar').onclick = () => { matriz = null; A.Local.limparMatriz(); marcarDesatualizado(); renderDistInfo(); };

  // ------------------------------------------------------------------ SINCRONIZAÇÃO
  let conflitoSync = null;
  function renderSync() {
    const c = Sync.cfg;
    $('syncCfg').innerHTML = `<p class="small muted">Com o Supabase (plano gratuito), todos da equipe usam os mesmos dados. Sem configuração, os dados ficam só neste navegador.</p>
      <div class="grid" style="grid-template-columns:1fr 1fr;gap:8px">
        <label class="f" style="grid-column:1/3">URL do projeto<input id="sbUrl" value="${esc(c.url)}" placeholder="https://xxxx.supabase.co"></label>
        <label class="f" style="grid-column:1/3">Chave pública (anon key)<input id="sbKey" value="${esc(c.anonKey)}"></label>
        <label class="f">Identificador do registro<input id="sbChave" value="${esc(c.chave)}"></label>
        <label class="f">Enviar automaticamente<input id="sbAuto" type="checkbox" ${c.auto ? 'checked' : ''}></label>
        ${c.sessao ? `<div style="grid-column:1/3" class="small">Conectado como <b>${esc(c.email)}</b>.</div>` : `
        <label class="f">E-mail<input id="sbEmail" value="${esc(c.email)}" autocomplete="username"></label>
        <label class="f">Senha<input id="sbSenha" type="password" autocomplete="current-password"></label>`}
      </div>
      <div class="row" style="margin-top:8px">
        ${c.sessao ? '<button class="b" id="sbSair">Sair</button><button class="b" id="sbEnviar">Enviar agora</button><button class="b" id="sbBaixar">Baixar agora</button>' : '<button class="b p" id="sbEntrar">Salvar e entrar</button>'}
      </div>
      <details style="margin-top:10px" ${c.sessao ? '' : 'open'}><summary><b>Como configurar o Supabase (uma vez)</b></summary>
        <ol class="small"><li>Crie uma conta gratuita em supabase.com e um projeto.</li><li>No SQL Editor, execute:</li></ol>
        <pre class="sql" id="sbSql">${esc(A.SQL_SUPABASE)}</pre><button class="b" id="sbCopiar">Copiar código</button>
        <p class="small">3. Em Project Settings → API, copie a URL e a chave <i>anon</i> para os campos acima. A senha não é guardada; o app guarda só a sessão.</p></details>`;
    const salvarCfg = () => { c.url = $('sbUrl').value.trim(); c.anonKey = $('sbKey').value.trim(); c.chave = $('sbChave').value.trim() || 'principal'; c.auto = $('sbAuto').checked; Sync.gravarCfg(); };
    if ($('sbEntrar')) $('sbEntrar').onclick = async () => {
      salvarCfg();
      try { await Sync.entrar($('sbEmail').value.trim(), $('sbSenha').value); syncErro = null; await baixarNuvem(false); }
      catch (e) { alerta('Não foi possível entrar: ' + e.message); }
      renderSync(); renderCabecalho();
    };
    $('sbCopiar').onclick = async () => { try { await navigator.clipboard.writeText(A.SQL_SUPABASE); $('sbCopiar').textContent = 'Copiado ✓'; } catch (e) { const r = document.createRange(); r.selectNodeContents($('sbSql')); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); $('sbCopiar').textContent = 'Selecionado: tecle Ctrl+C'; } };
    if ($('sbSair')) $('sbSair').onclick = () => { Sync.sair(); renderSync(); renderCabecalho(); };
    if ($('sbEnviar')) $('sbEnviar').onclick = () => { salvarCfg(); enviarNuvem(false); };
    if ($('sbBaixar')) $('sbBaixar').onclick = () => { salvarCfg(); baixarNuvem(true); };
    $('sbAuto').onchange = salvarCfg;
  }
  async function enviarNuvem(forcar) {
    if (!Sync.ativo()) return;
    try { await Sync.enviar(st, forcar === true); syncErro = null; conflitoSync = null; }
    catch (e) {
      if (e.conflito) { conflitoSync = e.conflito; syncErro = 'conflito'; }
      else syncErro = 'erro';
      console.warn(e);
    }
    renderCabecalho(); renderBanner();
  }
  // Baixa da nuvem. Se "perguntar" e houver dados locais diferentes, confirma antes de substituir.
  async function baixarNuvem(substituirSempre) {
    if (!Sync.ativo()) return 'sem-login';
    let res;
    try {
      const dados = await Sync.baixar();
      syncErro = null; conflitoSync = null;
      const vazioLocal = !st.clientes.length;
      if (!dados) {
        // nuvem vazia: envia o que houver aqui (nunca um estado em branco)
        if (!vazioLocal) { await Sync.enviar(st, true); res = 'enviou'; } else res = 'vazio';
      } else if (substituirSempre || vazioLocal || (dados.atualizadoEm > st.atualizadoEm && confirm('A nuvem tem uma versão mais recente dos dados. Carregar?'))) {
        st = dados; idxCli(); A.Local.salvar(st); edicao = null; res = 'baixou';
      } else res = 'mantido';
    } catch (e) { syncErro = 'erro'; console.warn(e); res = 'erro'; }
    renderTudo();
    return res;
  }

  // ------------------------------------------------------------------ janela de login (primeira entrada)
  const semLoginNestaSessao = () => { try { return sessionStorage.getItem('rotas.semLogin') === '1'; } catch (e) { return false; } };
  function abrirLogin() {
    $('lgEmail').value = Sync.cfg.email || ''; $('lgSenha').value = '';
    $('lgUrl').value = Sync.cfg.url || ''; $('lgKey').value = Sync.cfg.anonKey || '';
    // servidor já configurado (embutido): a seção fica oculta; só aparece se faltar algo ou a chave falhar
    const srvOk = !!(Sync.cfg.url && Sync.cfg.anonKey);
    $('lgSrv').style.display = srvOk ? 'none' : ''; $('lgSrv').open = !srvOk;
    $('lgMsg').textContent = ''; $('lgMsg').className = 'small';
    $('loginModal').classList.add('on');
    setTimeout(() => ($('lgEmail').value ? $('lgSenha') : $('lgEmail')).focus(), 50);
  }
  const fecharLogin = () => $('loginModal').classList.remove('on');
  function traduzErro(m) {
    if (/invalid login credentials/i.test(m)) return 'E-mail ou senha incorretos.';
    if (/email not confirmed/i.test(m)) return 'E-mail ainda não confirmado no Supabase (Authentication → Users).';
    if (/failed to fetch|networkerror|load failed/i.test(m)) return 'Sem conexão com o servidor. Verifique a internet e a URL do Supabase.';
    if (/invalid api key|no api key/i.test(m)) return 'Chave pública do Supabase inválida (veja "Servidor").';
    return m;
  }
  $('lgPular').onclick = () => { try { sessionStorage.setItem('rotas.semLogin', '1'); } catch (e) { /* ignora */ } fecharLogin(); };
  $('lgForm').onsubmit = async (e) => {
    e.preventDefault();
    const url = $('lgUrl').value.trim(), key = $('lgKey').value.trim();
    if (!url || !key) { $('lgSrv').open = true; $('lgMsg').className = 'small bad'; $('lgMsg').textContent = 'Informe a URL e a chave pública do Supabase em "Servidor".'; return; }
    Sync.cfg.url = url; Sync.cfg.anonKey = key; Sync.gravarCfg();
    $('lgEntrar').disabled = true; $('lgMsg').className = 'small muted'; $('lgMsg').textContent = 'Entrando…';
    try {
      await Sync.entrar($('lgEmail').value.trim(), $('lgSenha').value);
      $('lgMsg').textContent = 'Carregando os dados da equipe…';
      const r = await baixarNuvem(false);
      if (r === 'erro') throw new Error('login feito, mas não foi possível ler os dados. Confira se o código SQL foi executado no Supabase.');
      fecharLogin();
      if (r === 'vazio') irPara('importar');
    } catch (err) {
      $('lgMsg').className = 'small bad'; $('lgMsg').textContent = 'Não foi possível entrar: ' + traduzErro(err.message);
      if (/api key|conex/i.test(traduzErro(err.message))) { $('lgSrv').style.display = ''; $('lgSrv').open = true; }
    } finally { $('lgEntrar').disabled = false; renderCabecalho(); }
  };

  // ------------------------------------------------------------------ IMPORTAÇÃO meuResíduo
  const K_GEO = 'rotas.geocache.v1';
  let geoCache = {};
  try { geoCache = JSON.parse(localStorage.getItem(K_GEO) || '{}'); } catch (e) { geoCache = {}; }
  const gravarGeo = () => { try { localStorage.setItem(K_GEO, JSON.stringify(geoCache)); } catch (e) { /* ignora */ } };
  let pararGeo = false;

  function renderImportar() {
    const at = st.clientes.filter(c => c.ativo);
    const sem = at.filter(c => !M.temCoord(c)).length;
    const prec = {};
    at.forEach(c => { const k = M.temCoord(c) ? (c.geoPrecisao || 'informada') : 'sem localização'; prec[k] = (prec[k] || 0) + 1; });
    $('geoInfo').innerHTML = `<p class="small">${at.length} clientes ativos · <b class="${sem ? 'warn' : 'ok'}">${sem} sem localização</b> (não entram nas rotas).
      Precisão: ${Object.entries(prec).map(([k, v]) => `${esc(k)}: ${v}`).join(' · ')}</p>
      ${sem ? `<p class="small muted">Tempo estimado: cerca de ${Math.ceil(sem * 2.5 / 60)} min (até 4 consultas por endereço, 1 por segundo).</p>` : ''}`;
    if (st.importResumo && !$('impRes').innerHTML) $('impRes').innerHTML = resumoImport(st.importResumo);
  }

  function resumoImport(r) {
    return `<div class="banner"><b>Importado em ${new Date(r.em).toLocaleString('pt-BR')}</b>: ${r.total} clientes · ${r.ativos} ativos · ${r.inativados} inativados ·
      ${r.historico} rotas reais reconstruídas · veículos: ${esc(r.placas.join(', ') || '—')}</div>
      <table><tr><th>Frequência (ativos)</th><th class="n">Clientes</th></tr>${Object.entries(r.freqs).map(([k, v]) => `<tr><td>${esc(M.FREQ[k]?.nome || k)}</td><td class="n">${v}</td></tr>`).join('')}</table>
      ${r.avisos.map(a => `<p class="small warn">${esc(a)}</p>`).join('')}
      <p class="small muted">Confira os inativados na aba Clientes (filtro "inativos") e reative quem ainda for cliente. Em seguida, localize os endereços (passo 2).</p>`;
  }

  $('impBtn').onclick = async () => {
    const f = (id) => $(id).files[0];
    if (!f('impCli')) return alerta('Selecione pelo menos o Relatório de Clientes.');
    $('impRes').innerHTML = '<span class="muted">Lendo planilhas…</span>';
    try {
      const ler = async (id) => (f(id) ? Importar.lerPlanilha(f(id)) : null);
      const arqs = { clientes: await ler('impCli'), contratos: await ler('impCon'), coletas: await ler('impCol'), rotas: await ler('impRot') };
      const anteriores = st.clientes.filter(c => c.origem === 'meuResíduo');
      const res = Importar.processar(arqs, anteriores);
      if (!confirm(`Importar ${res.clientes.length} clientes do meuResíduo?${st.clientes.length ? ' O plano atual será refeito.' : ''}`)) { $('impRes').innerHTML = ''; return; }
      st.clientes = res.clientes;
      Importar.aplicarCache(st.clientes, geoCache);
      st.historico = res.historico;
      delete st.historicoCalc;
      if (res.veiculosPlacas.length) {
        st.veiculos = res.veiculosPlacas.map((p, i) => {
          const ex = st.veiculos.find(v => v.placa === p);
          return ex || { id: 'v' + (i + 1) + '_' + p, nome: p, placa: p, capacidade: 1500, consumo: 8, combustivel: 'gasolina', tipos: ['saude', 'industrial'] };
        });
      }
      st.plano = null; st.confirmados = {}; st.avulsas = []; st.indisponibilidades = []; st.params.hoje = hojeReal();
      const at = st.clientes.filter(c => c.ativo);
      const freqs = {}; at.forEach(c => { freqs[c.freq] = (freqs[c.freq] || 0) + 1; });
      st.importResumo = { em: new Date().toISOString(), total: st.clientes.length, ativos: at.length, inativados: st.clientes.length - at.length,
        historico: res.historico.length, placas: res.veiculosPlacas, freqs, avisos: res.avisos.concat(['Capacidade e consumo dos veículos são valores provisórios: ajuste em "Frota e eventos".']) };
      idxCli(); edicao = null; salvar();
      $('impRes').innerHTML = resumoImport(st.importResumo);
      renderCabecalho(); renderBanner(); renderImportar();
    } catch (e) { console.error(e); $('impRes').innerHTML = `<span class="bad">Falha na importação: ${esc(e.message)}</span>`; }
  };

  $('geoArq').onchange = async (e) => {
    const fl = e.target.files[0]; if (!fl) return;
    try {
      Object.assign(geoCache, JSON.parse(await fl.text())); gravarGeo();
      const n = Importar.aplicarCache(st.clientes, geoCache);
      salvar(); alerta(`${n} cliente(s) localizados a partir do arquivo.`); if (n) marcarDesatualizado();
    } catch (err) { alerta('Arquivo inválido: ' + err.message); }
    e.target.value = ''; renderImportar();
  };
  $('geoExp').onclick = () => {
    const blob = new Blob([JSON.stringify(geoCache)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'coordenadas-clientes.json'; a.click();
  };
  $('geoParar').onclick = () => { pararGeo = true; };
  $('geoBtn').onclick = async () => {
    pararGeo = false;
    $('geoBtn').disabled = true; $('geoParar').style.display = ''; $('geoBar').style.display = '';
    let n = 0;
    try {
      await Importar.geocodificar(st.clientes, geoCache, (k, t, c) => {
        $('geoBar').firstElementChild.style.width = (100 * k / t) + '%';
        $('geoProg').textContent = `${k} de ${t}: ${c.nome} → ${c.geoPrecisao}`;
        if (++n % 10 === 0) { gravarGeo(); salvar(true); }
      }, () => pararGeo);
    } catch (e) { alerta('Falha na geocodificação: ' + e.message); }
    gravarGeo(); idxCli();
    $('geoBtn').disabled = false; $('geoParar').style.display = 'none';
    marcarDesatualizado(); renderImportar();
  };

  // ------------------------------------------------------------------ HISTÓRICO (rotas reais)
  function renderHistorico() {
    const H = st.historico || [];
    if (!H.length) { $('histRes').innerHTML = '<span class="muted">Importe o Relatório de Coletas Realizadas para ver as rotas reais.</span>'; $('histCalc').disabled = true; return; }
    $('histCalc').disabled = false;
    const hc = st.historicoCalc;
    if (!hc) { $('histRes').innerHTML = `<span class="muted">${H.length} rotas reais de ${M.fmtData(H[0].data)} a ${M.fmtData(H[H.length - 1].data)}. Clique em "Calcular comparação".</span>`; return; }
    // ordem dos horários fisicamente impossível (coletas registradas fora de ordem): fora dos totais
    const suspeita = (r) => r.placa === '?' || (r.real > 1.6 * r.otim && r.real - r.otim > 150);
    const todos = hc.rows, R = todos.filter(r => !suspeita(r)), nSusp = todos.length - R.length;
    const tot = (k) => R.reduce((s, r) => s + r[k], 0);
    const real = tot('real'), otim = tot('otim'), vis = tot('n');
    const dias = new Set(R.map(r => r.data)).size;
    const pl = st.plano && st.plano.resumo;
    const porPlaca = {};
    R.forEach(r => { const p = porPlaca[r.placa] || (porPlaca[r.placa] = { dias: 0, n: 0, real: 0, otim: 0 }); p.dias++; p.n += r.n; p.real += r.real; p.otim += r.otim; });
    const kmVis = (k, n) => fmtN(k / Math.max(1, n), 2);
    $('histRes').innerHTML = `
      <div class="grid g4">
        <div class="kpi"><div class="l">Rotas reais (dias × veículo)</div><div class="v">${R.length}</div><div class="small muted">${dias} dias · ${fmtN(vis)} paradas</div></div>
        <div class="kpi"><div class="l">Distância real</div><div class="v">${fmtN(real)} km</div><div class="small muted">${kmVis(real, vis)} km por parada</div></div>
        <div class="kpi"><div class="l">Mesmos clientes, ordem otimizada</div><div class="v">${fmtN(otim)} km</div><div class="small ok">−${fmtN(100 * (1 - otim / real), 0)}% só reordenando</div></div>
        <div class="kpi"><div class="l">Plano otimizado (próximos dias)</div><div class="v">${pl ? kmVis(pl.km, pl.visitas) + ' km' : '—'}</div><div class="small muted">${pl ? `por parada · ${fmtN(pl.km / pl.nDias, 1)} km por dia útil (real: ${fmtN(real / dias, 1)})` : 'gere um plano para comparar'}</div></div>
      </div>
      <p class="small muted">Distâncias ${hc.fonte === 'ruas' ? 'pelas ruas (OSRM)' : 'estimadas (linha reta × fator)'}, calculadas em ${new Date(hc.em).toLocaleString('pt-BR')}.
      ${hc.semLocal ? `${hc.semLocal} parada(s) de clientes sem localização ou inativos foram desconsideradas.` : ''}
      ${nSusp ? `<span class="warn">${nSusp} rota(s) ficaram fora dos totais porque a ordem dos horários é fisicamente impossível (ex.: ir e voltar de Araxá duas vezes em 2 horas) — provavelmente coletas registradas fora de ordem; estão marcadas com ⚠ na tabela.</span>` : ''}
      A comparação por parada é a mais justa entre períodos diferentes: o plano também escolhe os dias e o veículo de cada cliente, o que a reordenação sozinha não faz.</p>
      <table style="margin-top:8px"><tr><th>Veículo</th><th class="n">Rotas</th><th class="n">Paradas</th><th class="n">km real</th><th class="n">km reordenado</th></tr>
      ${Object.entries(porPlaca).map(([p, v]) => `<tr><td>${esc(p)}</td><td class="n">${v.dias}</td><td class="n">${v.n}</td><td class="n">${fmtN(v.real)}</td><td class="n">${fmtN(v.otim)}</td></tr>`).join('')}</table>
      <h3>Por dia</h3><div class="tbl" style="max-height:420px"><table><tr><th>Data</th><th>Veículo</th><th>Horário</th><th class="n">Paradas</th><th class="n">km real</th><th class="n">km reordenado</th><th class="n">Diferença</th></tr>
      ${todos.map(r => `<tr style="${suspeita(r) ? 'opacity:.55' : ''}"><td>${suspeita(r) ? '⚠ ' : ''}${M.fmtCurto(r.data)}/${r.data.slice(0, 4)}</td><td>${esc(r.placa)}</td><td class="small">${esc(r.inicio.slice(0, 5))}–${esc(r.fim.slice(0, 5))}</td><td class="n">${r.n}</td>
        <td class="n">${fmtN(r.real, 1)}</td><td class="n">${fmtN(r.otim, 1)}</td><td class="n">${fmtN(100 * (1 - r.otim / Math.max(0.01, r.real)), 0)}%</td></tr>`).join('')}</table></div>`;
  }
  $('histCalc').onclick = async () => {
    const H = st.historico || [];
    const rows = []; let semLocal = 0;
    $('histCalc').disabled = true;
    try {
      for (let i = 0; i < H.length; i++) {
        const h = H[i];
        const ids = h.clientes.filter(id => mapCli.has(id) && M.temCoord(mapCli.get(id)));
        semLocal += h.clientes.length - ids.length;
        $('histProg').textContent = `rota ${i + 1} de ${H.length}`;
        if (!ids.length) continue;
        const mt = M.matrizIds(st, matriz, ids);
        let real = 0, a = 0;
        for (let k = 1; k <= ids.length; k++) { real += mt.dist[a * mt.n + k]; a = k; }
        real += mt.dist[a * mt.n];
        const P = { n: mt.n, dist: mt.dist, time: mt.time, V: 1, vehicles: [{ capacity: 1e9, costPerKm: 1, maxMin: 1e9 }],
          params: { Pcap: 0, Ptime: 0, Pun: 1e9, Pgap: 0, seed: 1 }, avail: new Uint8Array(1).fill(1), dayNum: new Int32Array(1) };
        const seq = await chamar('sequence', { problem: P, locs: ids.map((_, k) => k + 1), dems: ids.map(() => 0), svcs: ids.map(() => 0), v: 0 });
        rows.push({ data: h.data, placa: h.placa, n: ids.length, real, otim: Math.min(real, seq.km), inicio: h.inicio || '', fim: h.fim || '' });
      }
      st.historicoCalc = { rows, semLocal, em: new Date().toISOString(), fonte: matriz ? 'ruas' : 'estimativa' };
      salvar();
    } catch (e) { console.error(e); alerta('Erro ao calcular: ' + e.message); }
    $('histProg').textContent = ''; $('histCalc').disabled = false;
    renderHistorico();
  };

  // ------------------------------------------------------------------ backup
  $('bkExport').onclick = () => {
    const blob = new Blob([JSON.stringify(st, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `rotas-backup-${st.params.hoje}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('bkImport').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!d.clientes || !d.veiculos) throw new Error('arquivo não reconhecido');
      if (!confirm(`Substituir os dados atuais por ${d.clientes.length} clientes do arquivo?`)) return;
      st = d; idxCli(); edicao = null; salvar(); renderTudo();
    } catch (err) { alerta('Falha ao importar: ' + err.message); }
    e.target.value = '';
  };
  $('bkReset').onclick = () => {
    const nuvem = Sync.ativo() ? ' A sincronização está ativa: os dados também serão apagados na nuvem, para toda a equipe.' : '';
    if (!confirm(`Apagar todos os clientes, rotas e o plano? Parâmetros, veículos e feriados são mantidos.${nuvem} Sugestão: exporte um backup antes.`)) return;
    const novo = M.estadoInicial(hojeReal());
    ['params', 'veiculos', 'feriados', 'garagem'].forEach(k => { novo[k] = st[k]; });
    novo.params.hoje = hojeReal();
    st = novo; idxCli(); edicao = null; salvar(); renderTudo();
  };

  // ------------------------------------------------------------------ início
  renderTudo();
  (async () => {
    if (Sync.ativo()) await baixarNuvem(false);
    else if (!st.clientes.length && !semLoginNestaSessao()) abrirLogin();
  })();
  window.__app = { get st() { return st; }, otimizar };
})();
