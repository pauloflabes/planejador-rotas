/*
 * Armazenamento local, sincronização com Supabase (REST, sem biblioteca) e
 * cálculo da matriz de distâncias pelo OSRM público.
 */
(function (root) {
  'use strict';
  const K_ESTADO = 'rotas.estado.v1', K_MATRIZ = 'rotas.matriz.v1', K_SYNC = 'rotas.sync.v1';

  function lerJSON(k) { try { const s = localStorage.getItem(k); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
  function gravarJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { console.warn('falha ao gravar', k, e); return false; } }

  const Local = {
    carregar: () => lerJSON(K_ESTADO),
    salvar: (st) => gravarJSON(K_ESTADO, st),
    carregarMatriz: () => lerJSON(K_MATRIZ),
    salvarMatriz: (m) => gravarJSON(K_MATRIZ, m),
    limparMatriz: () => { try { localStorage.removeItem(K_MATRIZ); } catch (e) { /* ignora */ } },
  };

  // ------------------------------------------------------------------ Supabase
  // Servidor padrão da equipe. A chave pública (publishable/anon) pode ficar no código: quem protege os dados
  // é o login + a regra de acesso (RLS) — com novos cadastros DESATIVADOS no Supabase.
  const PADRAO = { url: 'https://yhdcklshhjvwjorduuvb.supabase.co', anonKey: 'sb_publishable_eAlSXL6EKUfapG8Y82sWtw_ZoagKRBD' };
  const Sync = {
    cfg: Object.assign({ url: '', anonKey: '', email: '', chave: 'principal', auto: true, sessao: null, remotoEm: null }, lerJSON(K_SYNC) || {}),
    gravarCfg() { gravarJSON(K_SYNC, this.cfg); },
    ativo() { return !!(this.cfg.url && this.cfg.anonKey && this.cfg.sessao); },
    // aceita a URL colada com sufixos do painel (ex.: .../rest/v1/)
    base() { return this.cfg.url.trim().replace(/\/+$/, '').replace(/\/(rest|auth)\/v1$/i, ''); },
    async entrar(email, senha) {
      const r = await fetch(`${this.base()}/auth/v1/token?grant_type=password`, {
        method: 'POST', headers: { apikey: this.cfg.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: senha }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error_description || j.msg || j.message || (r.status === 401 ? 'Invalid API key' : `falha no login (${r.status})`));
      this.cfg.email = email;
      this.cfg.sessao = { access_token: j.access_token, refresh_token: j.refresh_token, expira: Date.now() + (j.expires_in || 3600) * 1000 };
      this.gravarCfg();
    },
    sair() { this.cfg.sessao = null; this.gravarCfg(); },
    async token() {
      const s = this.cfg.sessao;
      if (!s) throw new Error('não conectado');
      if (Date.now() < s.expira - 60000) return s.access_token;
      const r = await fetch(`${this.base()}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST', headers: { apikey: this.cfg.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: s.refresh_token }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { this.sair(); throw new Error('sessão expirada, entre novamente'); }
      this.cfg.sessao = { access_token: j.access_token, refresh_token: j.refresh_token, expira: Date.now() + (j.expires_in || 3600) * 1000 };
      this.gravarCfg();
      return j.access_token;
    },
    async headers() { return { apikey: this.cfg.anonKey, Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' }; },
    async versaoRemota() {
      const r = await fetch(`${this.base()}/rest/v1/estado?id=eq.${encodeURIComponent(this.cfg.chave)}&select=atualizado_em`, { headers: await this.headers() });
      if (!r.ok) throw new Error(`erro ao consultar (${r.status})`);
      const j = await r.json();
      return j.length ? j[0].atualizado_em : null;
    },
    async baixar() {
      const r = await fetch(`${this.base()}/rest/v1/estado?id=eq.${encodeURIComponent(this.cfg.chave)}&select=dados,atualizado_em`, { headers: await this.headers() });
      if (!r.ok) throw new Error(`erro ao baixar (${r.status})`);
      const j = await r.json();
      if (!j.length) return null;
      this.cfg.remotoEm = j[0].atualizado_em; this.gravarCfg();
      return j[0].dados;
    },
    // Envia o estado. Se a nuvem tiver uma versão mais nova que a última vista, recusa (conflito).
    async enviar(st, forcar) {
      if (!forcar) {
        const rem = await this.versaoRemota();
        if (rem && this.cfg.remotoEm && new Date(rem) > new Date(this.cfg.remotoEm)) {
          const e = new Error('conflito'); e.conflito = rem; throw e;
        }
      }
      const agora = new Date().toISOString();
      const h = await this.headers();
      h.Prefer = 'resolution=merge-duplicates,return=minimal';
      const r = await fetch(`${this.base()}/rest/v1/estado`, { method: 'POST', headers: h, body: JSON.stringify({ id: this.cfg.chave, dados: st, atualizado_em: agora }) });
      if (!r.ok) throw new Error(`erro ao enviar (${r.status}): ${await r.text()}`);
      this.cfg.remotoEm = agora; this.gravarCfg();
    },
  };

  if (!Sync.cfg.url) Sync.cfg.url = PADRAO.url;
  if (!Sync.cfg.anonKey) Sync.cfg.anonKey = PADRAO.anonKey;

  const SQL_SUPABASE = `-- Execute no SQL Editor do Supabase (uma vez)
create table if not exists public.estado (
  id text primary key,
  dados jsonb not null,
  atualizado_em timestamptz not null default now()
);
alter table public.estado enable row level security;
create policy "somente usuarios autenticados" on public.estado
  for all to authenticated using (true) with check (true);
-- Depois: Authentication > Users > "Add user" para cada pessoa da equipe
-- e desative novos cadastros em Authentication > Providers > Email.`;

  // ------------------------------------------------------------------ OSRM (matriz pelas ruas)
  // Servidor público de demonstração: adequado para testes, não para uso intenso.
  const OSRM = 'https://router.project-osrm.org';
  const espera = (ms) => new Promise(r => setTimeout(r, ms));

  async function blocoOSRM(coords, srcIdx, dstIdx) {
    const uni = [...new Set(srcIdx.concat(dstIdx))];
    const pos = new Map(uni.map((g, i) => [g, i]));
    const cs = uni.map(g => `${coords[g][1].toFixed(6)},${coords[g][0].toFixed(6)}`).join(';');
    const url = `${OSRM}/table/v1/driving/${cs}?sources=${srcIdx.map(g => pos.get(g)).join(';')}&destinations=${dstIdx.map(g => pos.get(g)).join(';')}&annotations=distance,duration`;
    for (let tent = 0; tent < 4; tent++) {
      try {
        const r = await fetch(url);
        if (r.status === 429) { await espera(3000 * (tent + 1)); continue; }
        const j = await r.json();
        if (j.code !== 'Ok') throw new Error(j.message || j.code);
        return j;
      } catch (e) { if (tent === 3) throw e; await espera(2000 * (tent + 1)); }
    }
  }

  // Calcula (ou completa) a matriz. ids/coords: lista de locais (índice 0 = garagem).
  async function calcularMatriz(ids, coords, anterior, aoProgresso) {
    const n = ids.length;
    const m = { ids: ids.slice(), coords: coords.map(c => c.slice()), dist: new Array(n * n).fill(-1), time: new Array(n * n).fill(-1), fonte: 'osrm', geradoEm: new Date().toISOString() };
    let novos = [];
    if (anterior && anterior.ids) {
      const ix = new Map(anterior.ids.map((x, i) => [x, i]));
      const N0 = anterior.ids.length;
      for (let i = 0; i < n; i++) {
        const a = ix.get(ids[i]);
        const mesmo = a !== undefined && anterior.coords[a][0] === coords[i][0] && anterior.coords[a][1] === coords[i][1];
        if (!mesmo) { novos.push(i); continue; }
        for (let j = 0; j < n; j++) {
          const b = ix.get(ids[j]);
          if (b === undefined) continue;
          m.dist[i * n + j] = anterior.dist[a * N0 + b]; m.time[i * n + j] = anterior.time[a * N0 + b];
        }
      }
    } else novos = ids.map((_, i) => i);
    const todos = ids.map((_, i) => i);
    const B = 50;
    const blocos = [];
    const fatias = (arr) => { const o = []; for (let i = 0; i < arr.length; i += B) o.push(arr.slice(i, i + B)); return o; };
    if (novos.length === n) { for (const s of fatias(todos)) for (const d of fatias(todos)) blocos.push([s, d]); }
    else if (novos.length) {
      for (const s of fatias(novos)) for (const d of fatias(todos)) blocos.push([s, d]);
      for (const s of fatias(todos)) for (const d of fatias(novos)) blocos.push([s, d]);
    }
    for (let k = 0; k < blocos.length; k++) {
      const [s, d] = blocos[k];
      const j = await blocoOSRM(coords, s, d);
      s.forEach((gi, a) => d.forEach((gj, b) => {
        const dv = j.distances && j.distances[a][b], tv = j.durations && j.durations[a][b];
        if (dv !== null && dv !== undefined) m.dist[gi * n + gj] = Math.round(dv) / 1000;
        if (tv !== null && tv !== undefined) m.time[gi * n + gj] = Math.round(tv / 6) / 10;
      }));
      if (aoProgresso) aoProgresso(k + 1, blocos.length);
      await espera(1100); // respeita o limite do servidor público
    }
    return m;
  }

  async function geometriaRota(coordsLatLng) {
    const cs = coordsLatLng.map(c => `${c[1].toFixed(6)},${c[0].toFixed(6)}`).join(';');
    const r = await fetch(`${OSRM}/route/v1/driving/${cs}?overview=full&geometries=geojson`);
    const j = await r.json();
    if (j.code !== 'Ok') throw new Error(j.message || j.code);
    return { linha: j.routes[0].geometry.coordinates.map(p => [p[1], p[0]]), km: j.routes[0].distance / 1000, min: j.routes[0].duration / 60 };
  }

  async function geocodificar(endereco) {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&q=${encodeURIComponent(endereco)}`);
    const j = await r.json();
    return j.length ? { lat: +j[0].lat, lng: +j[0].lon, nome: j[0].display_name } : null;
  }

  root.Armazen = { Local, Sync, SQL_SUPABASE, calcularMatriz, geometriaRota, geocodificar };
})(window);
