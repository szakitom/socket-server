require('dotenv').config()
const Koa = require('koa')

const app = new Koa()

const fs = require('fs')
const { PNG } = require('pngjs')

const cors = require('koa2-cors')

const Router = require('koa-router')

const router = new Router()

const server = require('http').createServer(app.callback())
const io = require('socket.io')(server)

const WIDTH = 10
const HEIGHT = 10

const shuffle = (array) => {
  const a = array
  let j
  let x
  let i
  for (i = a.length - 1; i > 0; i -= 1) {
    j = Math.floor(Math.random() * (i + 1))
    x = a[i]
    a[i] = a[j]
    a[j] = x
  }
  return a
}

const getPNG = () => {
  try {
    const data = fs.readFileSync('canvas.png')
    const png = PNG.sync.read(data)
    const { width, height } = png
    if (width !== WIDTH && height !== HEIGHT) {
      console.error('Dimension missmatch')
    }
    return png.data
  } catch (error) {
    const empty = new PNG({ width: WIDTH, height: HEIGHT })
    fs.writeFileSync('canvas.png', PNG.sync.write(empty))
    return empty.data
  }
}

const png2DB = (png) => {
  const raw = new Uint8Array(png)
  const colors = []
  for (let index = 0; index < raw.length; index += 4) {
    colors.push(Array.from(raw.slice(index, index + 4)))
  }
  return colors
}

const db = png2DB(getPNG())

let freeRow = shuffle([...Array(WIDTH * HEIGHT).keys()])

router.get('/', (ctx) => {
  if (freeRow.length === 0) {
    ctx.status = 400
    throw new Error('No more free seats')
  } else {
    const index = freeRow.shift()
    const row = Math.floor(index / WIDTH)
    const column = index % WIDTH
    ctx.body = { row, column, index, color: db[index] }
  }
})

let users = []

// autoreconnect resolve
io.use((socket, next) => {
  if (socket.handshake.query.row && socket.handshake.query.column) {
    const { row, column } = socket.handshake.query
    const id = Number(row * WIDTH) + Number(column)
    if (freeRow.includes(id)) {
      freeRow = freeRow.filter((seat) => seat !== id)
    }
  }
  next()
})

const canvas = io.of('/canvas')
const client = io.of('/client')

canvas.on('connect', (socket) => {
  socket.emit('welcome', { db, width: WIDTH, height: HEIGHT })
  socket.emit('userCount', users.length)

  socket.on('save', (img, cb) => {
    if (
      socket.handshake.query.token &&
      socket.handshake.query.token === process.env.API_SECRET
    ) {
      const data = img.replace('data:image/png;base64,', '')
      const buf = Buffer.from(data, 'base64')
      if (!fs.existsSync('snapshots')) {
        fs.mkdirSync('snapshots')
      }
      fs.writeFileSync(
        `./snapshots/${Math.floor(new Date().getTime() / 1000)}.png`,
        buf
      )
      cb('Saved')
    } else {
      cb('Not allowed')
    }
  })

  socket.on('reset', (cb) => {
    if (
      socket.handshake.query.token &&
      socket.handshake.query.token === process.env.API_SECRET
    ) {
      for (let index = 0; index < db.length; index += 1) {
        db[index] = [0, 0, 0, 0]
      }
      canvas.emit('welcome', { db, width: WIDTH, height: HEIGHT })
      cb('Reset')
    } else {
      cb('Not allowed')
    }
  })
})

client.on('connection', (socket) => {
  const userID = socket.id
  if (!users.includes(userID)) {
    users.push(userID)
    canvas.emit('userCount', users.length)
  }

  socket.on('disconnect', () => {
    // remove user from users
    users = users.filter((user) => user !== socket.id)
    canvas.emit('userCount', users.length)
    // add index back
    if (socket.handshake.query.row && socket.handshake.query.column) {
      const { row, column } = socket.handshake.query
      const index = Number(row * WIDTH) + Number(column)
      freeRow.push(index)
    }
  })

  socket.on('color', ({ color: { r, g, b, alpha }, column, row }, cb) => {
    const index = Number(row * WIDTH) + Number(column)
    const color = [r, g, b, alpha]
    db[index] = color
    canvas.emit('colorChange', { color, column, row })
    cb()
  })
})

app.use(async (ctx, next) => {
  try {
    await next()
  } catch (err) {
    ctx.status = ctx.status || err.status || 500
    ctx.body = err.message
    ctx.app.emit('error', err, ctx)
  }
})

app
  .use(
    cors({
      origin: process.env.FRONTEND_ADDRESS,
    })
  )
  .use(router.routes())
  .use(router.allowedMethods())

server.listen(3000)

const exitHandler = (options) => {
  if (options.cleanup) {
    console.log('Saving...')
    const flat = db.flat()
    const png = new PNG({ width: WIDTH, height: HEIGHT })
    png.data = flat
    const buff = PNG.sync.write(png)
    fs.writeFileSync('canvas.png', buff)
  }
  if (options.exit) {
    process.exit()
  }
}

// EXIT event handlers

// do something when app is closing
process.on('exit', exitHandler.bind(null, { cleanup: true }))

// catches ctrl+c event
process.on('SIGINT', exitHandler.bind(null, { exit: true }))

// catches "kill pid" (for example: nodemon restart)
process.on('SIGUSR1', exitHandler.bind(null, { exit: true }))
process.on('SIGUSR2', exitHandler.bind(null, { exit: true }))
