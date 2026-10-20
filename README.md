# Projeto UpSeller — Chic Seek

Painel Node.js + PostgreSQL Neon + ponte Tampermonkey. Primeira versão: importação de catálogo/regras, consulta e definição de regra desejada. **Não altera regras no UpSeller.**

## Segurança
- Configure `DATABASE_URL`, `ADMIN_TOKEN` e `BRIDGE_TOKEN` no Render.
- Não publique tokens no GitHub nem no Tampermonkey compartilhado.
- A ponte exige Bearer BRIDGE_TOKEN; o painel exige Bearer ADMIN_TOKEN.
- Backups e reconciliação devem preceder a ativação de escritas.
- A regra suporta no máximo 500 SKUs, e um SKU só aparece em uma regra por conta.

## Rotas
- `GET /health` — banco online
- `GET /api/dashboard` — token de administrador
- `POST /api/bridge/catalog` — importação de produtos via ponte
- `POST /api/bridge/rules` — snapshot completo de regras via ponte
- `POST /api/products/:sku/desired` — salva apenas intenção, não altera UpSeller

A sincronização de regras e o executor de alterações serão implementados após validação de escrita, checagem de status e plano de reversão.