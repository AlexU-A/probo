var Docker = require('dockerode')
   ,through2 = require('through2')
   ,bunyan = require('bunyan')
   ,Promise = require('bluebird')
   ,TaskRunnerPlugins = require('./plugins/TaskRunner')
;

var GitCheckout = require('./plugins/TaskRunner/GitCheckout')
var AssetDownloader = require('./plugins/TaskRunner/AssetDownloader')

const ASSET_DIR = "/assets"
const SRC_DIR = "/src"

/**
 * Constructor for the container model.
 */
var Container = function(options) {
  this.create = this.create.bind(this);
  this.docker = new Docker(options.docker);
  this.build = options.build;
  this.jobConfig = options.jobConfig;
  this.log = options.log ? options.log.child({component: 'container'}) : bunyan.createLogger({name: 'container'});
  this.containerName = options.containerName || null;
  this.containerId = options.containerId || null;
  this.container = this.containerId ? this.docker.getContainer(this.containerId) : null;
  this.image = options.image;
  this.imageConfig = options.imageConfig;
  this.binds = options.binds || [];
  // Whether to attach to log output.
  this.attachLogs = options.attachLogs || false;
  this.assetsUrl = options.assetsUrl;
};

Container.prototype.buildSetupTasks = Promise.promisify(function(done) {
  var self = this;
  var config = this.jobConfig;

  var container = this;
  var build = this.build;
  var project = build.project;

  var tasks = [];

  // 1. Download the code
  var gc = new GitCheckout(container, {
    auth_token: project.service_auth.token,
    provider_type: project.provider.type,
    repo_slug: project.slug,
    ref: build.ref,
  })
  tasks.push(gc);

  // 2. Download the assets
  if(config.assets && this.assetsUrl){
    var ad = new AssetDownloader(container, {
      asset_server_url: this.assetsUrl,
      asset_bucket: (project.assets && project.assets.bucket) || project.id,
      assets: config.assets
    });
    tasks.push(ad);
  }

  done(null, tasks);
});

Container.prototype.buildUserTasks = Promise.promisify(function(done) {
  var self = this;
  var config = this.jobConfig;
  var tasks = [];

  var steps = config.steps;
  steps = Array.isArray(steps) ? steps : [steps];

  steps.forEach(function(step){
    var plugin = step.plugin || 'Shell'

    if (self.provisionerPlugins[plugin]) {
      var task = new self.provisionerPlugins[plugin](self, step);
      tasks.push(task);
    }
  })

  done(null, tasks);
});

/**
 * First class Promise method.
 *
 * helper method to run scripts, not
 * useful in an app because it doesn't pass up stream before its piped
 * out
 */
Container.prototype.runTasks = function(){
  return this.buildUserTasks().each(function(task){
    return task.run().then(function(result){
      // result: {stream, exec (Promise), task}
      result.stream.pipe(process.stdout)
      return result.exec.then(function(exec){
        console.log("Exit code:", exec.ExitCode)
        return result
      })
    })
  })
}

Container.prototype.runBuild = Promise.promisify(function(done) {
  var self = this;
  self.create(function(error, containerData) {
    if (error) return done(error);

    return self.runTasks().then(function(evaluated_tasks){
      return containerData
    }).nodeify(done)
  });
});

/**
 * Creates and starts this Docker container..
 *
 * The done callback will be called with errors (if one occured).
 */
Container.prototype.create = Promise.promisify(function(done) {
  var self = this;
  var docker = this.docker;

  var commandInfo = self.buildCommandInfo(self.imageConfig);

  var createOptions = {
    name: self.containerName,
    Image: self.image,
    ExposedPorts: commandInfo.exposedPorts,
    Cmd: commandInfo.command,
    Env: [
      `COMMIT_REF=${this.build.ref}`,
      `BUILD_ID=${this.build.id}`,
      `SRC_DIR=${SRC_DIR}`,
      `ASSET_DIR=${ASSET_DIR}`,
      `PWD=${SRC_DIR}`,
    ],
  }
  if (this.build.ref) {
    createOptions.Env.push(`COMMIT_REF=${this.build.ref}`);
  }
  var startOptions = {
    PortBindings:  commandInfo.portBindings,
    Binds: self.binds,
  };
  self.log.info('creating container');
  docker.createContainer(createOptions, function(error, container) {
    if (error) return done(error);
    self.id = container.id;
    self.container = container;
    if (error) return done(error);
    self.log.info('container created', { containerId: container.id });
    self.log.info('starting container', { containerId: container.id });
    if (self.attachLogs) {
      container.attach({ stream: true, stdout: true, stderr: true }, function(error, stream) {
        container.modem.demuxStream(stream, self.createLogWriteStream(), self.createLogWriteStream());
      });
    }
    container.start(startOptions, function(error, data) {
      if (error) return done(error);
      container.inspect(function (error, data) {
        self.containerInfo = data;
        done(error, data);
      });
    });
  });
});

/**
 * Tries to create a container or finds one by the ID instead
 */
Container.prototype.findOrCreate = function(){
  
}

/**
 * Returns the current status of the container
 */
Container.prototype.getState = Promise.promisify(function(done){
  return this.inspect()
    .then(function(info){ done(null, info.State); return info.State })
    .catch(done)
})

/**
 * Returns result of .inspect on container
 */
Container.prototype.inspect = Promise.promisify(function(done){
  this.container.inspect(function(err, info){
    return done(err, info)
  })
})

/**
 * Stop the container
 */
Container.prototype.stop = Promise.promisify(function(done){
  this.container.stop(done)
})

/**
 * restart (stop/start) container
 */
Container.prototype.restart = Promise.promisify(function(done){
  this.container.restart(done)
})

/**
 * start containere
 */
Container.prototype.start = Promise.promisify(function(done){
  this.container.start(done)
})

/**
 * Get the particular exposed port from container info.
 */
Container.prototype.getExposedPortFromContainerInfo = function(data, port) {
  try {
    return data.NetworkSettings.Ports[port + '/tcp'][0].HostPort;
  } catch(e){
    throw new Error('Could not find tcp port ' + port + ' on container ' + this.id);
  }
};

/**
 * Build the command and port exposing logic for starting a penelope powered container.
 */
Container.prototype.buildCommandInfo = function(image) {
  var command = [ 'penelope' ];
  var name = null;
  // TODO: Accept argument for image to use.
  var exposedPorts = {};
  var portBindings = {};
  for (name in image.services) {
    var service = image.services[name];
    command.push('-n');
    command.push(name);
    command.push('-c');
    command.push(service.command);
    if (service.port) {
      var protocol = service.protocol || 'tcp';
      var portString = service.port + '/' + protocol;
      exposedPorts[portString] = {};
      portBindings[portString] = [{ HostPort: null }];
    }
  }
  return {
    command: command,
    exposedPorts: exposedPorts,
    portBindings: portBindings
  };
}

Container.prototype.provisionerPlugins = TaskRunnerPlugins;

/**
 * Get a log handler stream appropriate to piping output to.
 */
Container.prototype.createLogWriteStream = function(options) {
  var stream = through2();
  stream.pipe(process.stdout);
  return stream;
};

module.exports = Container;
