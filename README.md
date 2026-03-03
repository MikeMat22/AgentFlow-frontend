# OpenClaw Wrapper

Minimalistický web UI wrapper nad OpenClaw gateway s lokálním Ollama modelem.

## Prerekvizity

- Node.js 22+
- OpenClaw běžící lokálně (`openclaw gateway start`)
- Ollama s modelem `qwen3:8b`

## Instalace

```bash
npm install
cp .env.example .env
npm start
```

Otevři http://localhost:3000

## Jak to funguje

```
Browser  →  Express server (port 3000)  →  OpenClaw WS gateway (port 18789)  →  Ollama
```

1. Frontend pošle POST `/api/chat` s textem zprávy
2. Server otevře WebSocket připojení k OpenClaw gateway
3. OpenClaw zpracuje zprávu přes Ollama (qwen3:8b)
4. Server streamuje odpověď zpět jako Server-Sent Events
5. Frontend zobrazuje tokeny v reálném čase

## Konfigurace (.env)

| Proměnná          | Default                   | Popis                    |
|-------------------|---------------------------|--------------------------|
| `OPENCLAW_WS`     | ws://127.0.0.1:18789      | OpenClaw gateway WS URL  |
| `OPENCLAW_TOKEN`  | ollama                    | Auth token               |
| `PORT`            | 3000                      | Port web serveru         |

## Struktura

```
openclaw-wrapper/
├── server.js          # Express + WS proxy
├── public/
│   └── index.html     # Celý frontend v jednom souboru
├── package.json
└── .env.example
```
