import { config as loadDotenv } from 'dotenv'

// .env holds defaults (committed, if ever); .env.local holds real secrets (gitignored) and
// wins when both are set -- same convention the client half of this repo gets from Vite.
// Must be imported before anything that reads process.env at module load time (config.ts).
loadDotenv()
loadDotenv({ path: '.env.local', override: true })
