import express from 'express'

const port = Number(process.env.PORT) || 4000

const app = express()

app.listen(port, () => {
  console.log(`[harness-server] listening on port ${port}`)
})
