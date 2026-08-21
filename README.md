# Canale WS Server

Server WebSocket "relay" per Canale. Non ha un suo database: il PHP resta
l'unica fonte di verità, questo server si limita a inoltrare in tempo reale
agli utenti collegati gli eventi che PHP gli comunica (nuovo messaggio,
reazione, typing, notifica, segnale voice).

**Se questo server è spento o mal configurato, il sito PHP continua a
funzionare normalmente** (torna semplicemente al polling automatico). Non è
un punto singolo di fallimento per la piattaforma.

## Deploy su Render (gratuito)

1. Carica questa cartella (`ws-server/`) come repository Git separato (o
   sotto-cartella di un repo, impostando "Root Directory" su `ws-server`
   nelle impostazioni Render).
2. Su [render.com](https://render.com) → **New +** → **Web Service** →
   collega il repository.
3. Impostazioni:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free va bene per iniziare
4. In **Environment** aggiungi le 3 variabili (vedi `.env.example`):
   - `INTERNAL_SECRET` — genera un valore lungo e casuale, es. con
     `openssl rand -hex 32` (su Linux/Mac) o un generatore di password
     online. **Deve essere identico** al valore che metterai in
     `includes/config.php` lato PHP (vedi sotto).
   - `PHP_BASE_URL` — l'URL pubblico del tuo sito PHP, es.
     `https://canale.esempio.tld` (senza slash finale).
   - `PORT` — su Render viene impostata automaticamente, non serve
     aggiungerla a mano (lasciala solo per test in locale).
5. Deploy. Render ti darà un URL tipo `https://canale-ws.onrender.com`.

## Collegare il sito PHP

In `includes/config.php` (sul sito PHP) imposta:

```php
define('WS_INTERNAL_URL', 'https://canale-ws.onrender.com'); // l'URL che ti ha dato Render
define('WS_INTERNAL_SECRET', 'lo-stesso-valore-di-INTERNAL_SECRET-su-Render');
```

Se lasci `WS_INTERNAL_URL` vuoto, il sito PHP non prova nemmeno a
contattare questo server e funziona esattamente come prima (solo polling).

## Nota sul piano gratuito di Render

Il piano gratuito "addormenta" il servizio dopo ~15 minuti di inattività: la
prima connessione dopo un periodo di inattività può metterci qualche
secondo in più. Se vuoi evitarlo, puoi usare un servizio di uptime-ping
gratuito (es. UptimeRobot) puntato su `https://tuo-servizio.onrender.com/`
ogni 5-10 minuti — non è necessario, il sito funziona comunque anche con
il servizio addormentato (il client si riconnette da solo quando risponde,
e nel frattempo il polling copre il ritardo).

## Test rapido in locale

```bash
cd ws-server
cp .env.example .env   # poi modifica i valori dentro .env
npm install
npm start
```
