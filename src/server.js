require('dotenv').config()
const mkdirp = require('mkdirp')
const express = require('express')
// const { promisify } = require('util')
const redis = require('redis')
const bluebird = require('bluebird')
bluebird.promisifyAll(redis.RedisClient.prototype)
const redisClient = redis.createClient(6379, '127.0.0.1')
const bufferRedisClient = redis.createClient(6379, '127.0.0.1', { return_buffers: true })
const basicAuth = require('basic-auth-connect')
const morgan = require('morgan')
const ipfilter = require('express-ipfilter').IpFilter
const ips = ['', '::1', '127.0.0.1']
const debugHttp = require('debug-http')
const fs = require('fs-extra')
const portscanner = require('portscanner')
redisClient.keys('video*', (err, rows) => {
  if (err) console.error('Error from flushCache: ', err)
  for (let row of rows) redisClient.del(row)
})
fs.emptyDirSync('public')
fs.removeSync('video')
mkdirp.sync('video')

process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0
debugHttp()

const SlingRouter = require('./sling-router')
const SlingManager = require('./sling-manager')

const DSTVRouter = require('./dstv-router')
const DSTVManager = require('./dstv-manager')

const BellRouter = require('./bell-router')
const BellManager = require('./bell-manager')

const ServerRouter = require('./server-router')
const VideoManager = require('./video-manager')

const VideoRouter = require('./video-router')

const Util = require('./util')

class Server {
  constructor () {
    this.socketConnections = []
    this.serverPort = null
  }

  findPort () {
    return new Promise((resolve, reject) => {
      portscanner.findAPortNotInUse(3001, 3020, '127.0.0.1', (error, port) => {
        if (error) reject(new Error('no ports found!'))
        console.log('AVAILABLE PORT AT: ' + port)
        resolve(port)
      })
    })
  }

  async start () {
    this.serverPort = await this.findPort()
    this.startServer()
    console.log(`\n\tRunning ${process.env.GAE_INSTANCE} auth-service at http://localhost:${this.serverPort}\n`)
  }

  startServer () {

    const videoManager = new VideoManager(new Util('video-manager'), redisClient, bufferRedisClient)

    const slingManager = new SlingManager(redisClient, new Util('sling-manager'), videoManager)
    const slingRouter = new SlingRouter(slingManager, new Util('sling-router'), videoManager)

    const dstvManager = new DSTVManager(new Util('dstv-manager'), redisClient, videoManager)
    const dstvRouter = new DSTVRouter(dstvManager, new Util('dstv-router'), videoManager)

    const bellManager = new BellManager(redisClient, new Util('bell-manager'))
    const bellRouter = new BellRouter(bellManager, new Util('bell-router'))

    const videoRouter = new VideoRouter(new Util('video-router'), videoManager)
    const serverRouter = new ServerRouter(new Util('server-router'), slingManager)

    const app = express()
    app.set('trust proxy', true)

    app.use(morgan(':date[iso] :method :url :status :res[content-length] - :response-time[0] ms'))

    app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*')

      if (req.method === 'OPTIONS') {
        res.sendStatus(200)
      } else {
        next()
      }
    })
    app.use('/static', ipfilter(ips, { mode: 'allow', logLevel: 'deny' }))
    app.use('/static', express.static('public'))
    app.use('/sec', express.static('public'))
    app.use('/secret', basicAuth('tpk', 'minions'))
    app.use('/secret', express.static('panels'))

    app.use('/sling', slingRouter.router)
	app.use('/dstv', dstvRouter.router)
	app.use('/bell', bellRouter.router)

    app.use('/video', videoRouter.router)

    app.use('/', serverRouter.router)

    this.server = app.listen(this.serverPort)
    this.server.on('connection', socket => {
      this.socketConnections.push(socket)

      socket.on('close', () => {
        this.socketConnections = this.socketConnections.filter(sock => sock !== socket)
      })
    })
  }
}

const server = new Server()
server.start()
