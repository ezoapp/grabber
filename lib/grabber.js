/*
 * grabber
 * https://github.com/ezoapp/grabber.git
 *
 * Copyright (c) 2014
 * Licensed under the MIT license.
 */

'use strict';

var _ = require('underscore'),
  request = require('request'),
  fs = require('fs'),
  cheerio = require('cheerio'),
  urllib = require('url'),
  pathlib = require('path'),
  glob = require('glob'),
  wrench = require('wrench'),
  hashids = new(require('hashids'))(new Date().getTime() + 'T');

function Grabber(data, options, logger, originUrl) {
  this.$ = null;
  this.data = data;
  this.baseUrl = '';
  this.tasklist = [];
  this.options = _.extend({
    dstDir: 'www',
    baseDir: '',
    tmplDir: '',
    indexFile: 'index.html'
  }, options || {});
  this.logger = (logger) ? logger : console;
  this.originUrl = new RegExp(originUrl, 'i');
  this.streamlist = [];
}

Grabber.prototype = (function () {

  var RES_TAG = {
    'href': ['link'], //,'a'],
    'src': ['img', 'script'], //, 'iframe'],
    'data-background-image': ['a']
  },
    USE_LOCAL_RES = {
      'http://code.jquery.com/mobile/1.4.2/jquery.mobile-1.4.2.min.js': 'gk/lib/jquery.mobile/1.4.2/jquery.mobile-1.4.2.min.js',
      'http://code.jquery.com/mobile/1.4.2/jquery.mobile-1.4.2.min.css': 'gk/lib/jquery.mobile/1.4.2/jquery.mobile-1.4.2.min.css',
      'http://code.jquery.com/mobile/1.4.2/jquery.mobile.external-png-1.4.2.min.css': 'gk/lib/jquery.mobile/1.4.2/jquery.mobile.external-png-1.4.2.min.css',
      'http://code.jquery.com/mobile/1.4.2/jquery.mobile.icons-1.4.2.min.css': 'gk/lib/jquery.mobile/1.4.2/jquery.mobile.icons-1.4.2.min.min.css',
      'http://code.jquery.com/mobile/1.4.2/jquery.mobile.inline-png-1.4.2.min.css': 'gk/lib/jquery.mobile/1.4.2/jquery.mobile.inline-png-1.4.2.min.min.css',
      'http://code.jquery.com/mobile/1.4.2/jquery.mobile.inline-svg-1.4.2.min.css': 'gk/lib/jquery.mobile/1.4.2/jquery.mobile.inline-svg-1.4.2.min.css',
      'http://code.jquery.com/mobile/1.4.2/jquery.mobile.structure-1.4.2.min.css': 'gk/lib/jquery.mobile/1.4.2/jquery.mobile.structure-1.4.2.min.css',
      'http://code.jquery.com/mobile/1.4.2/jquery.mobile.theme-1.4.2.min.css': 'gk/lib/jquery.mobile/1.4.2/jquery.mobile.theme-1.4.2.min.css'
      //          ,
      //          'http://jqmdesigner.appspot.com/1.4.2/gk/lib/jquery.mobile/1.4.2/flatui/jquery.mobile.flatui.css': 'gk/lib/jquery.mobile/1.4.2/flatui/jquery.mobile.flatui.css',
      //          'http://jqmdesigner.appspot.com/1.4.2/components/jquery.gk/jquery.gk.min.js': 'components/jquery.gk/jquery.gk.min.js',
      //          'http://jqmdesigner.appspot.com/1.4.2/components/gk-loader/gk-loader.js': 'components/gk-loader/gk-loader.js'
    },
    EXCLUDE_GKCOM = ['jqgrid', 'editor', 'niceditor', 'tab-panel'],
    EXCLUDE_GKLIB = ['ace', 'ace-min', 'backbone', 'bootstrap', 'codemirror', 'gk', 'htmlparser', 'jquery', 'jquery.cookie', 'jquery.mobile', 'jquery.nicescroll', 'jquery.ui.tabs', 'jqgrid', 'miniscroll-js', 'nicedit', 'require', 'require-css', 'require-text', 'split-pane'],
    EXCLUDE_COMS = ['ace', 'ace-builds', 'gk-editor', 'jquery', 'jquery.gk', 'jqgrid', 'widget-ext', 'widget-jquerymobile'];

  function run(cb) {
    var self = this,
      url = self.data;
    if (isValidUrl(url)) {
      self.baseUrl = pathlib.dirname(url);
      request(url, function (error, response, body) {
        if (!error && response.statusCode === 200) {
          self.$ = cheerio.load(body);
          self._(parse)(function (path) {
            cb(null, path);
          });
        } else {
          cb({
            error: error,
            response: response
          });
        }
      });
    } else {
      self.$ = cheerio.load(url);
      self._(parse)(function (path) {
        cb(null, path)
      });
    }
  }

  function close() {
    var self = this;
    _.each(self.streamlist, function (ele) {
      ele.end();
    });
  }

  function parse(callback) {
    var self = this,
      $ = self.$,
      dstDir = self.options.dstDir,
      comDir = '',
      gkTags = [],
      downloadProc = function () {
        self._(fetchFile)(function () {
          fs.writeFileSync(dstDir + '/' + self.options.indexFile, self._(replaceHtml)());
          self._(packageAll)(callback);
        });
      };
    _.each(RES_TAG, function (tags, attr) {
      _.each(tags, function (tag) {
        _.each($(tag), function (ele, idx) {
          var url = ele.attribs[attr];
          if (url) {
            if (isValidUrl(url)) {
              var realUrl = self._(replaceWithLocal)(url);
              ele.attribs[attr] = realUrl;
            }
            self._(queueDownload)(ele, attr);
            if (ele.attribs['components']) {
              // keep in dstDir
              //                comDir = pathlib.normalize(dstDir + '/' + urllib.parse(url).pathname + '/../../');
              gkTags = ele.attribs['components'].split(/[\s,]+/);
            }
          }
        });
      });
    });
    if (fs.existsSync(dstDir)) {
      wrench.rmdirSyncRecursive(dstDir);
    }

    self._(copyTmpl)(function () {
      if (gkTags.length) {
        self._(copyCom)(comDir, function () {
          downloadProc();
        });
      } else {
        downloadProc();
      }
    });

  }

  function queueDownload(ele, attr) {
    var self = this;
    if (_.isString(ele)) {
      self.logger.log('debug', '[queued] ' + ele);
      self.tasklist.push({
        url: ele
      });
    } else {
      self.logger.log('debug', '[queued] ' + ele.attribs[attr]);
      self.tasklist.push({
        ele: ele,
        attr: attr
      });
    }
  }

  function copyTmpl(callback) {
    var self = this,
      srcDir = self.options.tmplDir,
      dstDir = self.options.dstDir;
    wrench.mkdirSyncRecursive(dstDir);
    self.logger.log('debug', '[copyTmpl] ' + srcDir + ' -> ' + dstDir);
    wrench.copyDirSyncRecursive(srcDir, dstDir, {
      forceDelete: true
    });
    callback();
  }

  function copyCom(comDir, callback) {
    var self = this,
      srcDir = self.options.baseDir,
      dstDir = comDir || self.options.dstDir,
      //          comJs = {
      //            pattern: 'com/*\.js',
      //            exclude: _.map(EXCLUDE_GKCOM, function (com) {
      //              return 'com/' + com + '.js';
      //            })
      //          },
      //          coms = {
      //            pattern: 'com/*[^\.js]',
      //            exclude: _.map(EXCLUDE_GKCOM, function (com) {
      //              return 'com/' + com;
      //            })
      //          },
      //          libs = {
      //            pattern: 'lib/*',
      //            exclude: _.map(EXCLUDE_GKLIB, function (lib) {
      //              return 'lib/' + lib;
      //            })
      //          },
      coms = {
        pattern: './*',
        exclude: _.map(EXCLUDE_COMS, function (com) {
          return './' + com;
        })
      };
    wrench.mkdirSyncRecursive(dstDir + '/components');
    _.each([coms], function (col) {
      scanDir(srcDir + '/components', col.pattern, col.exclude, function (err, matches) {
        _.each(matches, function (f) {
          var src = srcDir + '/components/' + f,
            dst = dstDir + '/components/' + f,
            isFile = fs.lstatSync(src).isFile();
          self.logger.log('debug', '[copyCom] ' + src + ' -> ' + dst);

          wrench.mkdirSyncRecursive(pathlib.dirname(dst));
          if (isFile) {
            fs.writeFileSync(dst, fs.readFileSync(src));
          } else {
            wrench.copyDirSyncRecursive(src, dst, {
              forceDelete: true
            });
          }
        });
      });
    });
    callback();
  }

  function fetchFile(callback) {
    var self = this,
      tasklist = self.tasklist,
      srcDir = self.options.baseDir,
      dstDir = self.options.dstDir,
      logger = self.logger,
      count = 0,
      checkFinish = function () {
        count++;
        if (count >= tasklist.length) {
          logger.log('debug', '[fetchFile] finish...');
          callback();
        }
      };
    _.each(tasklist, function (t, idx) {
      var url = t.ele.attribs[t.attr];
      if (isValidUrl(url)) {
        self._(download)(idx, url, dstDir, function (err, path) {
          err ? logger.log('error', '[download] failed: ' + url + ', err: ' + err) : (t.path = path);
          checkFinish();
        });
      } else if (url.indexOf('data') !== 0) {
        self._(copyLocal)(idx, srcDir + '/' + url, dstDir + '/' + url, dstDir, function (err, path) {
          err ? logger.log('error', '[copy] failed: ' + url + ', err: ' + err) : (t.path = pathlib.relative(dstDir, path));
          checkFinish();
        })
      } else {
        checkFinish();
      }
    });
  }

  function replaceHtml() {
    var self = this,
      tasklist = self.tasklist;
    _.each(tasklist, function (t) {
      if (t.ele && t.attr && t.path) {
        t.ele.attribs[t.attr] = t.path;
      }
    });
    return self.$.html();
  }

  function packageAll(callback) {
    var self = this;
    callback(self.options.dstDir);
  }

  return {
    constructor: Grabber,
    run: run,
    close: close,
    _: function (privateMethod) {
      var self = this;
      return function () {
        return privateMethod.apply(self, arguments);
      };
    }
  };

  function replaceWithLocal(url) {
    if (this.originUrl.test(url)) {
      return url.replace(this.originUrl, '');
    }
    return (USE_LOCAL_RES[url]) ? (USE_LOCAL_RES[url]) : url;
  }

  function copyLocal(sn, srcPath, dstPath, dstDir, callback) {
    try {
      wrench.mkdirSyncRecursive(pathlib.dirname(dstPath));
    } catch (e) {
      dstPath = dstDir + '/' + id + pathlib.extname(dstPath);
    }
    try {
      if (fs.existsSync(dstPath)) {
        this.logger.log('debug', '[copyLocal] skip ' + dstPath);
      } else {
        fs.writeFileSync(dstPath, fs.readFileSync(srcPath));
        this.logger.log('debug', '[copyLocal] ' + srcPath + ' -> ' + dstPath);
      }
      callback(null, dstPath);
    } catch (e) {
      callback(e);
    }
  }

  function download(sn, url, dstDir, callback) {
    var path = urllib.parse(url).pathname,
      id = hashids.encrypt(sn),
      logger = this.logger,
      streamlist = this.streamlist,
      filepath;
    request.head(url, function (error, response, body) {
      if (!error) {
        if (fs.existsSync(dstDir + '/' + path)) {
          filepath = dstDir + '/' + pathlib.dirname(path) + '/' + pathlib.basename(path, pathlib.extname(path)) + id + pathlib.extname(path);
        } else {
          filepath = dstDir + '/' + path;
        }
        filepath = pathlib.normalize(filepath);
        try {
          wrench.mkdirSyncRecursive(pathlib.dirname(filepath));
        } catch (e) {
          filepath = dstDir + '/' + id + pathlib.extname(path);
        }
        var ws = fs.createWriteStream(filepath);
        ws.on('finish', function () {
          streamlist.splice(streamlist.indexOf(ws), 1);
        });
        streamlist.push(ws);
        request(url).pipe(ws);
        logger.log('debug', '[download] ' + url + ' -> ' + filepath);
        callback(error, pathlib.relative(dstDir, filepath));
      } else {
        callback(error);
      }
    });
  }

  function scanDir(baseDir, pattern, excludes, callback) {
    glob(pattern, {
      cwd: baseDir
    }, function (err, matches) {
      callback(err, _.difference(matches, excludes));
    });
  }

  function isValidUrl(str) {
    var url = urllib.parse(str);
    return url.protocol && url.protocol.indexOf('http') === 0;
  }

}());

exports.Grabber = Grabber;
