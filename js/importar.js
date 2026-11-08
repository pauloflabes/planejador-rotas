/*
 * Importação dos relatórios exportados do meuResíduo (.xlsx) e geocodificação dos endereços.
 * Relatórios: Clientes, Contratos, Coletas Realizadas e Rotas (todos opcionais, exceto Clientes).
 */
(function (root) {
  'use strict';

  function norm(s) {
    return String(s === null || s === undefined ? '' : s).normalize('NFD').replace(/[^\x00-\x7f]/g, '').toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const digitos = (s) => String(s || '').replace(/\D/g, '');
  const chaveEndereco = (c) => [c.rua, c.numero, c.cep, c.cidade].map(norm).join('|');

  // "dd/mm/aaaa[ hh:mm:ss]" -> "aaaa-mm-dd"
  function dataISO(s) {
    const m = String(s || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  }

  async function lerPlanilha(arquivo) {
    const buf = await arquivo.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null });
  }

  // Converte as linhas de um relatório em objetos, a partir da linha de cabeçalho cuja 1ª célula é uma das chaves.
  function tabela(linhas, chaves) {
    const h = linhas.findIndex(r => r && r[0] !== null && chaves.includes(String(r[0]).trim()));
    if (h < 0) throw new Error(`cabeçalho não encontrado (esperado "${chaves[0]}" na primeira coluna)`);
    const cab = linhas[h].map(v => (v === null ? null : String(v).trim()));
    const out = [];
    for (const r of linhas.slice(h + 1)) {
      if (!r) continue;
      const o = {};
      let tem = false;
      cab.forEach((k, i) => { if (k) { const v = r[i] === null || r[i] === undefined ? null : String(r[i]).trim(); o[k] = v; if (v) tem = true; } });
      if (tem) out.push(o);
    }
    return out;
  }

  // Frequência do meuResíduo -> frequência do programa (o dia da semana do contrato é ignorado)
  function frequencia(txt) {
    const s = String(txt || '').trim();
    if (!s || s === '0') return 'demanda';
    if (/^semanal/i.test(s)) return 'semanal';
    if (/^bissemanal/i.test(s)) return 'quinzenal';
    if (/^di[aá]rio/i.test(s)) return 'diario';
    const m = s.match(/a cada\s*(\d+)\s*mes/i);
    if (/^mensal/i.test(s)) {
      const n = m ? Number(m[1]) : 1;
      return n <= 1 ? 'mensal' : n === 2 ? 'bimestral' : n <= 4 ? 'trimestral' : 'semestral';
    }
    return 'demanda';
  }
  const ORDEM_FREQ = ['diario', '2x', 'semanal', 'quinzenal', 'mensal', 'bimestral', 'trimestral', 'semestral', 'demanda'];
  const VISITAS_MES = { diario: 21, '2x': 8.6, semanal: 4.3, quinzenal: 2.15, mensal: 1, bimestral: 0.5, trimestral: 0.33, semestral: 0.17, demanda: 1 };

  function processar(arqs, anterior) {
    const { clientes: lc, contratos: lt, coletas: lo, rotas: lr } = arqs;
    const cli = tabela(lc, ['#ID']);
    const con = lt ? tabela(lt, ['ID']) : [];
    const col = lo ? tabela(lo, ['#']) : [];
    const rot = lr ? tabela(lr, ['ID da ROTA']) : [];
    const avisos = [];

    // contratos por cliente: fica a frequência mais alta
    const contrato = new Map();
    for (const c of con) {
      if (!c.ID || (c['Status Contr.'] && c['Status Contr.'] !== 'Ativo')) continue;
      const f = frequencia(c['Freq. Col.']);
      const atual = contrato.get(c.ID);
      if (!atual || ORDEM_FREQ.indexOf(f) < ORDEM_FREQ.indexOf(atual.freq)) {
        const pac = parseFloat(String(c['Quantidade total dos pacotes'] || '').replace(',', '.'));
        contrato.set(c.ID, { freq: f, texto: c['Freq. Col.'] || '', pacoteKg: (c['Un. Med. (Pacote)'] === 'kg' && pac > 0) ? pac : null });
      }
    }

    // coletas: kg por visita, última data, tipo de resíduo, sequência real das rotas
    const visitas = new Map(), ultima = new Map(), classes = new Map();
    const seq = new Map(); // "data|placa" -> [{hora, id}]
    for (const c of col) {
      const id = c['ID Cliente']; const dt = dataISO(c.Data);
      if (!id || !dt) continue;
      const kv = `${id}|${dt}`;
      const q = parseFloat(String(c.Quantidade || '0').replace(',', '.')) || 0;
      visitas.set(kv, (visitas.get(kv) || 0) + q);
      if (!ultima.has(id) || ultima.get(id) < dt) ultima.set(id, dt);
      if (c['Classe do Resíduo']) { if (!classes.has(id)) classes.set(id, new Set()); classes.get(id).add(c['Classe do Resíduo']); }
      const placa = c['Placa do Veículo'] || '?';
      const ks = `${dt}|${placa}`;
      if (!seq.has(ks)) seq.set(ks, []);
      seq.get(ks).push({ hora: String(c.Data).slice(11, 19), id });
    }
    const kgMedio = new Map();
    for (const [kv, q] of visitas) {
      const id = kv.split('|')[0];
      if (q <= 0) continue;
      if (!kgMedio.has(id)) kgMedio.set(id, []);
      kgMedio.get(id).push(q);
    }

    // rotas (ago–out): quem aparece nas rotas, por CPF/CNPJ
    const docsEmRota = new Set(rot.map(r => digitos(r['CNPJ do Cliente'])).filter(Boolean));
    const placas = new Map();
    let ultimaDataRota = '';
    for (const r of rot) { const d = dataISO(r['Data de Término(Período Previsto)']); if (d && d > ultimaDataRota) ultimaDataRota = d; }
    for (const r of rot) {
      const d = dataISO(r['Data de Término(Período Previsto)']); const p = r['Placa do Veículo'];
      if (!p || !d) continue;
      if (!placas.has(p)) placas.set(p, { linhas: 0, recentes: 0 });
      placas.get(p).linhas++;
      if (Modelo.dnum(ultimaDataRota) - Modelo.dnum(d) <= 30) placas.get(p).recentes++;
    }
    for (const [ks, lst] of seq) { const p = ks.split('|')[1]; if (!placas.has(p)) placas.set(p, { linhas: 0, recentes: lst.length }); }

    const antPorId = new Map((anterior || []).map(c => [c.id, c]));
    const clientes = [];
    const vistos = new Set();
    for (const c of cli) {
      const id = String(c['#ID'] || '').trim();
      if (!id || vistos.has(id)) continue;
      vistos.add(id);
      const ct = contrato.get(id);
      const freq = ct ? ct.freq : 'demanda';
      const kgs = kgMedio.get(id);
      let kg = kgs ? kgs.reduce((a, b) => a + b, 0) / kgs.length : null;
      if (kg === null && ct && ct.pacoteKg) kg = ct.pacoteKg / VISITAS_MES[freq];
      if (kg === null) kg = 3;
      const cl = classes.get(id);
      const tipo = cl && [...cl].every(x => !/grupo/i.test(x)) ? 'industrial' : 'saude';
      const ultRel = dataISO(c['Última Coleta']);
      const ultCol = ultima.get(id) || null;
      const ult = [ultRel, ultCol].filter(Boolean).sort().pop() || null;
      // trimestral/semestral podem não aparecer numa janela de 3 meses: não inativa automaticamente
      const emRota = docsEmRota.has(digitos(c.CNPJ)) || ultima.has(id) || freq === 'trimestral' || freq === 'semestral';
      const ant = antPorId.get(id);
      const rua = (c['Endereço'] || '').replace(/\s+/g, ' ').trim();
      const numero = (c['Número do Endereço'] || '').trim();
      const novo = {
        id, nome: (c['Nome Fantasia'] || c['Razão social'] || id).trim(), razao: (c['Razão social'] || '').trim(), cnpj: c.CNPJ || '',
        rua, numero, bairro: (c.Bairro || '').trim(), cep: (c.CEP || '').trim(), cidade: (c.Cidade || '').trim(), uf: c.Estado || 'MG',
        endereco: `${rua}${numero ? ', ' + numero : ''}${c.Bairro ? ' — ' + c.Bairro.trim() : ''} — ${c.Cidade || ''}`,
        tipo, freq, tol: null, kg: Math.max(0.5, Math.round(kg * 10) / 10), servico: null,
        ultimaColeta: ult, inicio: null,
        ativo: freq === 'demanda' ? true : emRota, motivoInativo: (freq !== 'demanda' && !emRota) ? 'Sem rota nem coleta no período dos relatórios (inativado na importação)' : '',
        contrato: ct ? ct.texto : '(sem contrato ativo)', lat: null, lng: null, geoPrecisao: null, origem: 'meuResíduo',
      };
      // preserva ajustes manuais feitos no programa (coordenadas, tolerância, ativo, tempo de atendimento)
      if (ant) {
        if (ant.lat && ant.geoPrecisao && chaveEndereco(ant) === chaveEndereco(novo)) { novo.lat = ant.lat; novo.lng = ant.lng; novo.geoPrecisao = ant.geoPrecisao; }
        if (ant.tol !== null && ant.tol !== undefined) novo.tol = ant.tol;
        if (ant.servico !== null && ant.servico !== undefined && ant.servico !== '') novo.servico = ant.servico;
        if (ant.ativoManual !== undefined) { novo.ativo = ant.ativoManual; novo.ativoManual = ant.ativoManual; novo.motivoInativo = ant.ativoManual ? '' : 'Inativado manualmente'; }
      }
      clientes.push(novo);
    }
    const semContrato = clientes.filter(c => !contrato.has(c.id)).length;
    if (semContrato) avisos.push(`${semContrato} cliente(s) sem contrato ativo foram tratados como "conforme necessidade".`);

    // histórico real (ordem pelo horário de cada coleta)
    const historico = [];
    for (const [ks, lst] of seq) {
      const [data, placa] = ks.split('|');
      lst.sort((a, b) => a.hora.localeCompare(b.hora));
      const ids = [];
      for (const x of lst) if (!ids.includes(x.id)) ids.push(x.id);
      historico.push({ data, placa, clientes: ids, inicio: lst[0].hora, fim: lst[lst.length - 1].hora });
    }
    historico.sort((a, b) => (a.data + a.placa).localeCompare(b.data + b.placa));

    const veiculosPlacas = [...placas.entries()].filter(([p, v]) => p !== '?' && v.recentes >= 10).sort((a, b) => b[1].recentes - a[1].recentes).map(x => x[0]);
    return { clientes, historico, veiculosPlacas, avisos, contagem: { relClientes: cli.length, contratos: con.length, linhasColeta: col.length, linhasRota: rot.length } };
  }

  // ------------------------------------------------------------------ geocodificação (Nominatim)
  const espera = (ms) => new Promise(r => setTimeout(r, ms));
  async function nominatim(params) {
    const qs = new URLSearchParams(Object.assign({ format: 'json', limit: '1', countrycodes: 'br' }, params)).toString();
    for (let t = 0; t < 3; t++) {
      try {
        const r = await fetch('https://nominatim.openstreetmap.org/search?' + qs);
        if (r.status === 429) { await espera(5000 * (t + 1)); continue; }
        const j = await r.json();
        await espera(1100);
        return j.length ? j[0] : null;
      } catch (e) { await espera(3000 * (t + 1)); }
    }
    return null;
  }
  function km(a, b) { return Modelo.haversine(a, b); }

  async function geocodificar(clientes, cache, aoProgresso, deveParar) {
    const centros = new Map();
    const alvo = clientes.filter(c => c.ativo && (!c.lat || !c.lng));
    let feitos = 0;
    for (const c of alvo) {
      if (deveParar && deveParar()) break;
      const k = chaveEndereco(c);
      let res = cache[k];
      if (!res) {
        if (!centros.has(c.cidade)) { const g = await nominatim({ city: c.cidade, state: 'Minas Gerais' }); centros.set(c.cidade, g ? [+g.lat, +g.lon] : null); }
        const ctr = centros.get(c.cidade);
        const num = (c.numero || '').replace(/\D.*/, '');
        const tent = [['rua', { street: `${num} ${c.rua}`.trim(), city: c.cidade, state: 'Minas Gerais' }], ['rua', { street: c.rua, city: c.cidade, state: 'Minas Gerais' }],
          ['cep', c.cep ? { postalcode: c.cep, city: c.cidade } : null], ['bairro', { q: `${c.bairro}, ${c.cidade}, Minas Gerais` }]];
        for (const [prec, p] of tent) {
          if (!p) continue;
          const g = await nominatim(p);
          if (g && (!ctr || km([+g.lat, +g.lon], ctr) < 35)) {
            res = { lat: +(+g.lat).toFixed(6), lng: +(+g.lon).toFixed(6), precisao: prec === 'rua' && num && p.street.startsWith(num) ? 'numero' : prec };
            break;
          }
        }
        if (!res && ctr) res = { lat: ctr[0], lng: ctr[1], precisao: 'cidade' };
        if (!res) res = { lat: null, lng: null, precisao: 'falhou' };
        cache[k] = res;
      }
      if (res.lat) { c.lat = res.lat; c.lng = res.lng; c.geoPrecisao = res.precisao; }
      else c.geoPrecisao = 'falhou';
      feitos++;
      if (aoProgresso) aoProgresso(feitos, alvo.length, c);
    }
    return { total: alvo.length, feitos };
  }

  function aplicarCache(clientes, cache) {
    let n = 0;
    for (const c of clientes) {
      if (c.lat && c.lng) continue;
      const r = cache[chaveEndereco(c)];
      if (r && r.lat) { c.lat = r.lat; c.lng = r.lng; c.geoPrecisao = r.precisao; n++; }
    }
    return n;
  }

  root.Importar = { lerPlanilha, processar, geocodificar, aplicarCache, chaveEndereco, frequencia, norm };
})(window);
