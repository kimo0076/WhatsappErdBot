# WhatsappErdBot

Professional multi-tenant WhatsApp AI order bot — Arabic-first, built on [Baileys](https://github.com/WhiskeySockets/Baileys).

## Features

- **AI-powered chat** — intent classification, order extraction, smart replies via OpenCode Go
- **Order state machine** — pending → confirmed → location → in-transit → completed
- **Supervisor dashboard** — `/orders`, `/approve`, `/reject`, `/deliver`, `/complete`, `/assign`, `/stock`, `/report`
- **Location collection** — WhatsApp location share + text address
- **Backorder support** — order out-of-stock products with supervisor approval
- **Auto-cancel** — stale orders cancelled automatically after configurable hours
- **Product import** — CSV file upload with AI extraction + inline paste
- **Bilingual** — Arabic/English commands, Arabic-first UI

## Setup

```bash
cp .env.example .env
# Fill in your API keys
npm install
npm start
```

## Environment

| Variable | Description |
|----------|-------------|
| `OPENCODE_GO_API_KEY` | OpenCode Go API key |
| `AI_MODEL` | Model name (default: `deepseek-v4-flash`) |
| `AI_MAX_TOKENS` | Max tokens (default: `2500`) |
| `WA_SESSION_PATH` | Auth session path (default: `./data/auth_info`) |

## Commands (Supervisor)

| Command | Description |
|---------|-------------|
| `طلبات` | List pending orders |
| `حالة ORD-xxx` | View order details |
| `موافقة ORD-xxx` | Approve order |
| `رفض ORD-xxx` | Reject order |
| `توصيل ORD-xxx` | Mark as in transit |
| `إنهاء ORD-xxx` | Mark as completed |
| `تعيين ORD-xxx رقم` | Assign delivery |
| `تقرير` | Quick stats |
| `تقرير مفصل` | Full daily report |
| `مخزون` | View inventory |
| `ناقص` | Low stock items |
| `استيراد` | Import products from CSV |

## Customer Commands

| Keyword | Action |
|---------|--------|
| `منتجات` | Product catalog |
| `فئات` | Category list |
| `طلب` / `أريد` | Place order |

## Credit

Designed by Mohammed Hashem Almashehary (@kim0_07)

## License

MIT
