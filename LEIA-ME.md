# Planejamento de Rotas — Ambiental Transportes

Otimização de rotas periódicas (PVRP) que roda inteiramente no navegador. Não precisa de servidor.

## Arquivos
- `index.html`: interface (Leaflet + OpenStreetMap).
- `js/solver.js`: otimizador (ALNS + 2-opt/or-opt), executado em Web Worker.
- `js/modelo.js`: calendário, feriados, frequências, dados fictícios e montagem do problema.
- `js/sync.js`: armazenamento local, sincronização com Supabase, matriz OSRM e geocodificação.
- `js/app.js`: telas e fluxos.

## Como abrir
- **No computador:** dê dois cliques em `iniciar.bat` (abre em http://localhost:8765; deixe a janela preta aberta enquanto usa).
  Abrir o `index.html` direto também funciona, mas sem busca de endereços e sem distâncias pelas ruas.
- **Publicar de graça:** crie um repositório no GitHub, envie os arquivos (o `.gitignore` já exclui dados reais) e ative *Settings → Pages*.

## Fluxo diário
1. **Início → Revisar e confirmar**: retire ou inclua clientes na rota do próximo dia útil.
2. **Confirmar**: o app sequencia a rota e reotimiza os 60 dias seguintes a partir do plano atual (padrão de 20 s).
3. **Avançar dia ▸** só existe para simular a passagem dos dias no protótipo.

## Modelo (resumo)
- Tolerâncias padrão: semanal ±1, quinzenal ±2, mensal ±4, bimestral ±6 dias (ajustáveis por cliente). 2x/semana usa seg+qui ou ter+sex.
- O custo é o combustível (km × diesel ÷ consumo de cada veículo) mais penalidades: jornada, capacidade, intervalo entre coletas, atraso, mudança de data já comunicada e visita não programada.
- Feriados nacionais e da cidade-base param a frota. Feriados de outras cidades só bloqueiam os clientes daquela cidade.

## Importar dados reais do meuResíduo
**Configurações → Importar meuResíduo**:
1. Selecione os relatórios de Clientes (obrigatório), Contratos, Coletas Realizadas e Rotas, e clique em **Importar**.
2. Localize os endereços: carregue `dados-privados/coordenadas-clientes.json` (já geocodificado) ou use **Geocodificar pendentes**. Corrija no mapa (Clientes → editar) os que ficaram com precisão "cidade" ou "bairro".
3. Confira os clientes inativados (Clientes → filtro "inativos") e reative quem ainda for cliente.
4. Ajuste capacidade, consumo e combustível dos veículos em **Configurações → Veículos** e otimize.
5. Aba **Histórico real**: compara as rotas de set–out com a ordem otimizada e com o plano.

Para reimportar depois (relatórios novos), repita o passo 1: coordenadas, tolerâncias e ativações manuais são preservadas.

## Enviar a rota confirmada ao meuResíduo
A extensão fica na pasta `extensao-meuresiduo/` e funciona no Chrome e no Edge.

**Instalar:** abra `chrome://extensions` (ou `edge://extensions`), ligue o **Modo do desenvolvedor**, clique em **Carregar sem compactação** e escolha a pasta `extensao-meuresiduo`. Recarregue o Planejamento de Rotas.

**Usar:**
1. Faça login no meuResíduo.
2. No planejador, abra o dia confirmado e clique em **Enviar ao meuResíduo** na rota do veículo.
3. A extensão abre um formulário novo e preenche instruções, clientes na ordem do planejador, origem (Empresa), destino (SERQUIP Uberlândia), retorno (Empresa) e motorista. A descrição da rota é a cidade e o dia (com mais de uma cidade, todas são listadas, começando pela que tem mais clientes). A aba Resíduo fica em branco.
4. Confira o resumo no canto da tela e as 5 abas. **Quem clica em Salvar é sempre você.**

A extensão nunca marca "Emitir MTR ao gerar a Rota" e nunca usa "Otimizar Rota". O motorista de cada veículo fica em **Configurações → Veículos**, com o nome igual ao do meuResíduo. Clientes criados só no planejador não têm código do meuResíduo e ficam fora do envio, com aviso.

## Privacidade
Os dados reais ficam só no navegador (e no Supabase, se configurado). **Nunca publique** a pasta `dados-privados/`, planilhas ou backups `.json` no GitHub: o `.gitignore` já os exclui.
