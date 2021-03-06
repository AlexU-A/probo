"use strict";

var http = require('http')
   ,url = require('url')
   ,Docker = require('dockerode')
   ,Promise = require('bluebird')
   ,co = require('../lib/safeco')
   ,FlakeId = require('flake-idgen')
   ,restify = require('restify')
   ,level = require('level')
   ,JSONStream = require('JSONStream')
   ,format  = require('biguint-format')
   ,ms  = require('ms')
   ,wait = require('co-wait')
   ,waitForPort = require('./waitForPort')
   ,Container = require('./Container')
   ,logger = require('./logger')
   ,runTasks = require("./container_manager/task_runner")
   ,loom = require("./loom")
;

Promise.longStackTraces();

const SETUP_CONTEXT = "env"

/**
 * The container manager object that contains all routes.
 */
var Server = function() {
  this.configure = this.configure.bind(this);
  this.run = this.run.bind(this);
  this.flakeIdGen = new FlakeId();
  for (let verb in this.routes) {
    for (let route in this.routes[verb]) {
      this.routes[verb][route] = this.routes[verb][route].bind(this);
    }
  }

  this.containerIdleTimeouts = {}
}

/**
 * Starts the server.
 */
Server.prototype.run = function(probo, done) {
  var self = this;
  this.server.listen(probo.config.port, function(error) {
    self.log.info('server started and listening on ' + self.server.url);
    done(error);
  });
}


/**
 * Configures the server.
 */
Server.prototype.configure = function(config, done) {
  var self = this;
  this.config = config;
  this.log = logger.getLogger('container-manager');

  var API = require('./api');

  this.api = API.getAPI({
    url: this.config.api.url,
    token: this.config.api.token,
    buildUrl: this.config.buildUrl,
    log: this.log
  });

  var server = restify.createServer({
    name: config.name,
    version: require('../package').version,
    log: this.log.child({component: 'http'}),
  });
  server.use(restify.acceptParser(server.acceptable));
  server.use(restify.bodyParser({ mapParams: false }));
  server.use(restify.queryParser({ mapParams: false }));

  // Extend logger using the plugin.
  server.use(restify.requestLogger({
    serializers: restify.bunyan.serializers
  }));

  server.use(function (req, res, next) {
    req.log.info({req: req}, 'REQUEST');
    next();
  });

  server.on('after', restify.auditLogger({
    log: server.log
  }));

  server.on('uncaughtException', function (req, res, route, err) {
    console.log("uncaughtException", err.stack)
    req.log.error({err: err}, "uncaughtException");
    //err._customContent = 'something is wrong!';
  });

  for (var verb in this.routes) {
    for (var route in this.routes[verb]) {
      server[verb](config.prefix + '/' + route, this.routes[verb][route]);
    }
  }

  this.server = server;
  // Allow the db to be handed in with the config.
  this.db = config.levelupDB || level(config.dataDir, { valueEncoding: 'json' });

  this.loom = loom({url: config.loom.url}, this.log)

  // update safeco's error handler with bunyan logging one
  co = co(function(err, opts){
    (opts.req || self).log.error({err: err}, "Uncaught co Exception")

    if(opts.res){
      try {
        opts.res.send(err)
      } catch(e){
        // headers already sent, reponse started
        // write error to the response and end it
        var req_id_str = opts.req ? `(req id ${opts.req.id()})` : ''
        opts.res.end(`\n\nERROR: ${err.message}, terminating response ${req_id_str}`)
      }
    }

    // let middleware continue
    if(opts.next){
      opts.next()
    }
  })

  done();
}

/**
 * Define empty route structures so that it is easy to layer them on below.
 */
Server.prototype.routes = {
  get: {},
  post: {},
  put: {},
  del: {},
};

/**
 * Create a new build in a new envrionment.
 */
Server.prototype.routes.post['startbuild'] = function(req, res, next) {
  var body = req.body, // {build, project}
      build = body.build,
      project = body.project;

  req.log.debug(body, "Starting Build")

  req.buildId = build.id
  build.project = project;
  var self = this;

  co(function* (){
    try {
      var result = yield self.runBuild(build, req.log)
      res.json(result)
    } catch (error){
      var status = error.status || 500
      res.json(status, {error: error.message});
      req.log.error({err: error})
    }
    return next()
  }, {req, res, next})
}


Server.prototype.runBuild = function* (build, log) {
  var self = this

  log = log.child({bid: build.id}, true)

  build.active = true
  var project = build.project

  try {
    yield self.storeBuildDataAsync(build)
  } catch(error){
    log.error({err: error}, "Failed to write build to the BD")
    error.status = 400 // respond with a HTTP 400 status code
    throw error
  }

  var image = build.config.image || this.config.defaultImage
  var containerName = `${self.config.containerNamePrefix}--${project.slug.replace('/', '.')}--${project.id}--${build.id}`

  var container_config = {
    // config from the build
    docker: self.config.docker,
    build: build,
    jobConfig: build.config,
    containerName: containerName,
    containerId: containerName,
    image: image,
    imageConfig: self.config.images[image],

    // global config
    binds: self.config.binds,
    // attachLogs: true, // set to true to attach 'docker -f logs' to stdout of this process

    assetsUrl: this.config.assets.url
  };

  log.info(`Starting container build: ${containerName}`)
  // log.debug({build, container_config}, "Starting container build")

  // attach logger
  container_config.log = log;

  var container = new Container(container_config);

  // gather all the tasks
  var setup_tasks = yield container.buildSetupTasks()
  var user_tasks = yield container.buildUserTasks()

  var updateStatus = function* (context, status){
    try {
      // prefix context with ProboCI namespace
      var instance = self.config.instanceName || 'ProboCI'
      context = `${instance}/${context}`

      yield self.api.setBuildStatusAsync(build, context, status)
      log.info({status}, "status updated")
    } catch (e){
      log.error({err: e}, "Failed to update build status")
    }
  }

  // handle status updates for setup task
  for(let task of setup_tasks){
    task.on("update", function (context, status){
      // ignore context, it'll always be SETUP_CONTEXT
      // and for self-updates, action will always be 'running'
      // and state is 'pending' beause "env" status isn't complete
      // until we're ready to run user steps
      status.action = 'running'
      status.state = 'pending'
      co(updateStatus(SETUP_CONTEXT, status))
    })
  }

  // handle status updates for each task
  for(let task of user_tasks){
    task.on("update", function (context, status){
      co(updateStatus(context, status))
    })
  }



  // continue processing the build in the background and firing off events
  setImmediate(function (){
    co(function* (){
      // RUN INITIALIZATION STEPS
      try {
        yield* updateStatus(SETUP_CONTEXT, {state: "pending", action: 'running', description: `The hamsters are working hard on your setup`})

        yield container.create() // returns output of container.inspect

        yield* updateStatus(SETUP_CONTEXT, {state: "pending", action: 'running', description: 'Environment built'})
      } catch(e){
        switch(e.statusCode){

        case 409: // container conflict, reuse existing container
          log.warn(`Container ${containerName} is already exists, reusing it if not started`)

          var state = yield container.getState()
          if(state.Running){
            // oh oh, there might be a problem
            log.error(`Container ${containerName} is already running, bailing`)
            yield* updateStatus(SETUP_CONTEXT, {state: "error", action: 'finished', description: 'Build already in progress'})
            let err = new Error(`Build ${build.id} is already in progress`)
            err.status = 400
            throw err
          }

          yield container.start()

          yield* updateStatus(SETUP_CONTEXT, {state: "pending", action: 'running', description: 'Reusing existing environment'})
          break

        default:
          log.error({err: e}, "Unknown container error")
          yield* updateStatus(SETUP_CONTEXT, {state: "error", action: 'finished', description: e.message})
          throw e
        }
      }

      yield* runTasks(setup_tasks, {log: log, container: container, loom: self.loom, setup: true})

      // container has been created, run initialization tasks
      yield* updateStatus(SETUP_CONTEXT, {state: "success", action: 'finished', description: 'Environment ready'})


      // RUN ALL USER TASKS
      yield* runTasks(user_tasks, {log: log, container: container, loom: self.loom})

      try {
        build.active = false

        // save the container information for the build
        build.container = {
          id: container.container.id,
          name: containerName
        }

        yield self.storeBuildDataAsync(build)
      } catch(error){
        log.error({err: error}, "Failed to write build to the BD")
      }
    })
  }, 0)

  // return a response to the requestor
  return {
    status: "build started",
    container: {
      id: container.container.id || null,
      name: containerName
    },
    build: {
      id: build.id
    },
    steps: user_tasks.length
  }
};

/**
 * List active probo containers on the server
 */
Server.prototype.routes.get['containers'] = function(req, res, next) {
  var docker = new Docker(this.config.docker)
  var self = this

  docker.listContainers(function (err, containers) {
    if(err) return next(err)

    function filter(containerInfo){
      // .Names is an array, and first name in array is the main name
      // container names in docker start with a /, so look for our prefix
      // starting with second character (index 1)
      return containerInfo.Names[0].indexOf(self.config.containerNamePrefix) === 1
    }

    function toInstances(containerInfo){
      // return our Container instances
      return new Container({
        docker: self.config.docker,
        containerId: containerInfo.Id,
      })
    }

    containers = containers.filter(filter).map(toInstances)

    co(function*(){
      var inspects = containers.map(function(c){ return c.inspect() })
      var infos = yield inspects // inspect all containers in parallel
      infos = infos.map(function(info){
        return {
          id: info.Id,
          name: info.Name,
          state: info.State,
          ports: info.NetworkSettings.Ports
        }
      })

      res.json({
        capacity: self.config.containerCapacity || -1,
        active:  containers.length,
        containers: infos
      })
      next()
    }, {req, res, next})
  });
};


/**
 * Get information about an active container for a build.
 * Start container if it's not running
 * GET /build/:buildId/container/proxy
 */
Server.prototype.routes.post['builds/:bid/container/proxy'] = function(req, res, next) {
  var self = this

  var buildId = req.params.bid
  if(!buildId){
    return next(new restify.InvalidContentError("bid param required"));
  }

  co(function* (){
    // find build object for our build id
    var build
    try {
      build = yield self.getFromDBAsync('builds', buildId)
    } catch(err){
      if(err.notFound){
        return next(new restify.ResourceNotFoundError("Build not found for build id: " + buildId));
      }
    }

    // lookup container object for the build
    if(!build.container){
      return next(new restify.ResourceNotFoundError("Build does not have an associated container (yet?)"));
    }

    var container = new Container({
      docker: self.config.docker,
      containerId: build.container.id,
    })

    try {
      var state = yield container.getState()
      var setIdleTimeout = false
      if(!state.Running){
        yield container.start()
        setIdleTimeout = true
      } else {
        // 𝅘𝅥𝅮𝅘𝅥𝅮𝅘𝅥𝅮
        // We didn't start the fire
        // It was always burning
        // Since the world's been turning
        // 𝅘𝅥𝅮𝅘𝅥𝅮𝅘𝅥𝅮
      }

      self.resetContainerIdleTimeout(container, setIdleTimeout, req.log)

      // find port 80 mapping for this container
      var targetPort = 80
      var inspectInfo = yield container.inspect()
      var exposedHostPort = container.getExposedPortFromContainerInfo(inspectInfo, targetPort)


      // wait for the port to be up before responding if it's not up yet
      var up = true
      try {
        var start = new Date().getTime()
        var port_opts = { numRetries: 10, retryInterval: 500, debug: req.log.debug.bind(req.log) }
        yield waitForPort('localhost', exposedHostPort, port_opts)
        req.log.debug(`Container port ${targetPort}/${exposedHostPort} up`)

        // wait for containerStartupPause if specified when container starts
        // temp until we have a better solution
        // defaults to 0 (no wait), looks at probo config startupPause, CM config proxyStartupPause
        // in that order
        if(setIdleTimeout){
          let startupPause = +ms(build.config.startupPause || self.config.proxyStartupPause || '0')
          if(startupPause){
            req.log.debug(`Container starting, pausing for ${ms(startupPause)}`)
          }
          yield wait(startupPause)
        }

      } catch (e){
        up = false
        var duration = (new Date().getTime()) - start
        req.log.warn(`Service connection timed out (${e}) on container port ${targetPort}/${exposedHostPort} after ${duration}ms. Continuing with proxy response anyway.`)
      }


      // respond with port, host, and build job config
      var url_parts = url.parse('http://' + req.header('host'))
      req.log.debug({url_parts}, "parsed HOST header")
      delete url_parts.host  // if host is set, port isn't used in .format()
      url_parts.port = exposedHostPort

      res.json({
        proxy: {
          host: url_parts.hostname,
          port: url_parts.port,
          url: url.format(url_parts)
        },
        buildConfig: build.config,
        status: {
          up: up,
          info: up ? 'ok' : `Timed out after ${duration}ms`,
          ts: new Date()
        }
      })
      return next()
    } catch(e){
      // problems interacting with the container
      req.log.error({err: e}, "Problem starting or starting container")
      return next(new restify.ResourceNotFoundError("Could not get container, error: " + e.message));
    }
  }, {req, res, next})
}

/**
 * List builds on this server.
 */
Server.prototype.routes.get['builds'] = function(req, res) {
  var readStream = this.streamFromDB('builds')
  var jsonStream  = new JSONStream.stringify()
  readStream.pipe(jsonStream).pipe(res);
};

/**
 * List builds on this server.
 */
Server.prototype.routes.get['builds/:id'] = function(req, res) {
  this.getFromDB('builds', req.params.id, function(error, data) {
    if (error) return res.send(404, error);
    res.send(data);
  });
};

/**
 * Trigger a re-build of an existing build. No body required, just the build id
 */
Server.prototype.routes.post['builds/:id'] = function(req, res, next) {
  var self = this
  req.buildId = req.params.id

  this.getFromDB('builds', req.params.id, function(error, build) {
    if (error) return res.send(404, error);

    // clear a few build-related things
    delete build.container
    delete build.active

    co(function* (){
      try {
        var result = yield self.runBuild(build, req.log)
        res.json(result)
      } catch (error){
        var status = error.status || 500
        res.json(status, {error: error.message});
        req.log.error({err: error})
      }
      return next()
    }, {req, res, next})
  });
};

/**
 * Delete an individual build.
 */
Server.prototype.routes.del['builds/:id'] = function(req, res) {
  this.log.info('deleting build ' + req.params.id);
  this.delFromDB('builds', req.params.id, function(error) {
    if (error) return res.send(500, error);
    res.send('success');
  });
};


Server.prototype.resetContainerIdleTimeout = function(container, set, log){
  var idleTimeout = this.config.containerIdleTimeout || "10m"
  var containerId = container.containerId

  var to = this.containerIdleTimeouts[containerId]
  if(set || to){
    // reset timeout if it's already existing, or 'set' flag is set to true (we just started container)

    clearTimeout(to)
    log.info({id: containerId}, `Resetting container idle timeout to ${ms(ms(idleTimeout))}`)

    // stop container after the timeout
    this.containerIdleTimeouts[containerId] = setTimeout(function(){
      log.info({id: containerId}, "Stopping container")
      container.stop()
    }, ms(idleTimeout))
  }
}


/**
 * Store build data.
 */
Server.prototype.storeBuildData = function(data, done) {
  return this.storeInDB("builds", data, done);
};


/**
 * Store data with the specified prefix key. Automatically assings id to data if it's not there
 */
Server.prototype.storeInDB = function(key, data, done) {
  if (!data.id) {
    data.id = format(this.flakeIdGen.next(), 'hex');
  }
  this.db.put(key + '!' + data.id, data, function(error) {
    done(error, data);
  });
};

/**
 * Delete data from db based on key and id
 */
Server.prototype.delFromDB = function(key, id, done) {
  this.db.del(key + '!' + id, done);
};

/**
 * Get value from DB based on key and id
 */
Server.prototype.getFromDB = function(key, id, done) {
  this.db.get(key + '!' + id, { valueEncoding: 'json' }, done);
};

/**
 * Stream data from the db with keys prefixed with 'key'. Data is streamed as JSON objects
 */
Server.prototype.streamFromDB = function(key) {
  var readStream = this.db.createValueStream({
    gte: key + '!!',
    lte: key + '!~',
    valueEncoding: 'json',
  });
  return readStream;
};

Promise.promisifyAll(Server.prototype)

module.exports = Server;
