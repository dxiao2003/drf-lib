var errorModule = angular.module('drf-lib.error', ['angular.filter']);

var errorParser = function(lowercaseFilter, ucfirstFilter) {
  this.ucfirstFilter = ucfirstFilter;
  this.lowercaseFilter = lowercaseFilter;
};

errorParser.$inject = ['lowercaseFilter', 'ucfirstFilter'];

errorParser.prototype.extractMessage = function(response) {
  var self = this;
  if (response.data && response.data.non_field_errors)
    return response.data.non_field_errors.join(' ');
  else if (response.data && response.data.detail)
    return response.data.detail;
  else if (response.status == 400) {
    var msg = "";
    for (var field in response.data) {
      msg += self.ucfirstFilter(self.lowercaseFilter(field)) +
        ": " + response.data[field] + " ";
    }
    return msg;
  } else if (response.statusText)
    return self.ucfirstFilter(self.lowercaseFilter(response.statusText));
  else if (angular.isString(response))
    return response;
  else
    return "Service unavailable";
};

errorModule.service('errorParser', errorParser);
/**
 * Created by David on 9/28/2015.
 */
angular.module("drf-lib.util", [])
  .service("restServiceHelper",
  ["drfUtil",
    function(drfUtil) {
      var self = this;

      /**
       * Creates a new list function that sends a request possibly with filters
       * and takes a response that is paginated.  The response is assumed to be
       * an object with a results attribute and possibly a count attribute.
       *
       * @param resource
       * @param postProcess
       * @returns {Function}
       */
      self.createListFunction = function(resource, postProcess) {
        return function(filterArgs) {
          filterArgs = drfUtil.underscoredProperties(filterArgs) || {};

          var p = resource.get(filterArgs).$promise;

          if (!postProcess)
            postProcess = function(x) { return x; };

          return p.then(postProcess).then(function(result) {
            if (result.hasOwnProperty("results")) {
              var ret = result.results;
              if (angular.isNumber(result.count)) 
                ret.count = result.count;
              return ret;
            } else 
              return result;
          });
        };
      };
    }
  ])
  .service("drfUtil", ['$window', '$q', function($window, $q) {
    var self = this;
    var s = $window.s;

    function createStringRewriter(f) {
      function rewriter(str) {
        if (angular.isArray(str)) {
          var arr = str;
          var arrCopy = [];
          for (var i = 0; i < arr.length; i++)
            arrCopy.push(rewriter(arr[i]));
          return arrCopy;
        } else if (angular.isObject(str)) {
          var obj = str, objCopy = {};
          for (var property in obj) {
            if (obj.hasOwnProperty(property) && property.indexOf('$') !== 0) {
              if (angular.isObject(obj[property]))
                objCopy[f(property)] = rewriter(obj[property]);
              else
                objCopy[f(property)] = obj[property];
            }
          }

          return objCopy;
        } else {
          return str;
        }
      }

      return rewriter;
    }

    self.camelizeProperties = createStringRewriter(s.camelize);
    self.underscoredProperties = createStringRewriter(s.underscored);

    self.wrapMethod = function(f, beforeCall, afterCall) {
      return function () {
        beforeCall();
        var ret = f.apply(this, arguments);
        if (ret && ret.then)
          return ret.then(
            function(r) {
              afterCall();
              return r;
            },
            function (e) {
              afterCall();
              return $q.reject(e);
            }
          );
        else {
          afterCall();
          return ret;
        }
      };
    };

    self.wrapMethods =  function (obj, beforeCall, afterCall) {
      var copy = angular.copy(obj);
      copy.wrapped = {};
      for (var k in obj) {

        if (angular.isFunction(obj[k])) {
          var methodClosure = function(f) {
            return function() {
              return f.apply(obj, arguments);
            };
          };
          copy.wrapped[k] = self.wrapMethod(
            methodClosure(obj[k]),
            beforeCall,
            afterCall
          );
        }
      }
      return copy;
    };

    self.uuid4 = function() {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    };
    
  }]);
angular.module('drf-lib.auth.rest', ['ngResource', 'rest-api.url'])
  .service('authRest',
    ['$http', 'urlOf', "$q", "drfUtil",
      function($http, urlOf, $q, drfUtil) {
        function extractToken(response) {
          if (response.status == 200)
            return response.data.key;
          else
            throw response;
        }
    
        this.login = function (u, p) {
          return $http.post(urlOf['login'], {'username': u, 'password': p})
            .then(extractToken);
        };
    
        this.externalLogin = function(provider, request) {
          request = drfUtil.underscoredProperties(request);
          if (urlOf[provider + "-login"]) {
            return $http.post(urlOf[provider + "-login"], request)
              .then(extractToken);
          } else
            return $q.reject({"provider": provider});
        };
    
        this.logoutEverywhere = function() {
          return $http.post(urlOf['logout']);
        };
        return this;
      }
    ]
  );
/**
 * Created by David on 7/16/2015.
 */

var authModule = angular.module(
  'drf-lib.auth.services', ['drf-lib.auth.rest']
)
  .service(
  'authInterceptor',
  ['$injector', 'urlService', "$q",
    function($injector, urlService, $q) {
      return {
        'responseError': function(response) {
          var authService = $injector.get('authService');
          if ((response.status == 401) && authService.isAuthenticated()) {
            authService.logout(response);
          }
          return $q.reject(response);
        },
        'request': function(config) {
          var authService = $injector.get('authService');
          if (urlService.domainRequiresAuthorization(config.url) &&
              authService.isAuthenticated()) {
            config.headers = config.headers || {};
            config.headers['Authorization'] = authService.authHeader();
          }
          return config;
        }
      };
    }
  ])
  .config(['$httpProvider', function($httpProvider) {
    $httpProvider.interceptors.push('authInterceptor');
  }]);


var authService =
  function(authRest, $localStorage, $injector, $log,
           loginCallbacks, logoutCallbacks) {
    var self = this;

    self.authRest = authRest;
    self.$localStorage = $localStorage;
    self.$injector = $injector;
    self.$log = $log;
    self.loginCallbacks = loginCallbacks;
    self.logoutCallbacks = logoutCallbacks;

    if ($localStorage.auth && $localStorage.auth.token)
      self.setIdentity($localStorage.auth.token, $localStorage.auth.username);
  };

authService.prototype.login = function (u, p) {
  var self = this;
  return self.authRest.login(u, p).then(function(token) {
    self.setIdentity(token, u);
    return token;
  });
};

authService.prototype.externalLogin = function(provider, request) {
  var self = this;
  return self.authRest.externalLogin(provider, request).then(function(token) {
    self.setIdentity(token, u);
    return token;
  });
};

authService.prototype.setIdentity = function(token, username) {
  var self = this;
  self.$localStorage.auth = { token: token, username: username };

  // run callbacks
  for (var i = 0; i < self.loginCallbacks.length; i++) {
    var callback = self.loginCallbacks[i];
    try {
      self.$injector.invoke(
        callback, null, {token: token, username: username, 'authService': self}
      );
    } catch (e) {
      self.$log.error("error running login callback: " + e);
    }
  }
};

authService.prototype.logout = function(errorResponse) {
  var self = this;
  if (self.$localStorage.auth)
    delete self.$localStorage.auth.token;
  if (self.$localStorage.username)
    delete self.$localStorage.auth.username;

  // run callbacks
  for (var i = 0; i < self.logoutCallbacks.length; i++) {
    var callback = self.logoutCallbacks[i];
    try {
      self.$injector.invoke(
        callback,
        self,
        {
          'authService': self,
          'response': errorResponse
        }
      );
    } catch (e) {
      self.$log.error("error running logout callback: " + e);
    }
  }
};

authService.prototype.logoutEverywhere = function() {
  var self = this;
  return self.authRest.logoutEverywhere().then(function(r) {
    self.logout();
    return r;
  });
};

authService.prototype.getToken = function() {
  var self = this;
  if (self.$localStorage.auth)
    return self.$localStorage.auth.token;
};

authService.prototype.getUsername = function() {
  var self = this;
  if (self.$localStorage.auth)
    return self.$localStorage.auth.username;
};

authService.prototype.authHeader = function() {
  var self = this;
  return "Token " + self.getToken();
};

authService.prototype.isAuthenticated = function() {
  var self = this;
  return self.$localStorage.auth && !!self.$localStorage.auth.token;
};

authModule.provider('authService', function () {
  var self = this;
  var loginCallbacks = [];
  var logoutCallbacks = [];

  self.addLoginCallback = function(callback) {
    loginCallbacks.push(callback);
  };

  self.addLogoutCallback = function(callback) {
    logoutCallbacks.push(callback);
  };

  self.$get = [
    'authRest', '$localStorage', '$injector', '$log',
    function (authRest, $localStorage, $injector, $log) {
      return new authService(
        authRest, $localStorage, $injector, $log,
        loginCallbacks, logoutCallbacks
      );
    }
  ];
});


angular.module("drf-lib.user.rest", ["ngResource", "rest-api.url"])
  .service("userRest", ["$resource", "urlOf", "$http", "drfUtil",
    function($resource, urlOf, $http, drfUtil) {
      var self = this;
      var postProcess = function(result) {
        return drfUtil.camelizeProperties(result);
      };
      var extractData = function(result) {
        return result.data;
      };

      self.getProfile = function() {
        var User = $resource(urlOf["rest-auth-user"]);
        return User.get().$promise.then(postProcess);
      };

      self.setProfile = function(profile) {
        profile = drfUtil.underscoredProperties(profile);
        var User = $resource(urlOf["rest-auth-user"], undefined,
          {update: {method:"PUT"}});
        var u = new User(profile);
        return u.$update().then(postProcess);
      };

      self.setPassword = function(password, password2) {
        return $http.post(urlOf['rest-auth-set-password'], {
          new_password1: password,
          new_password2: password2
        }).then(extractData).then(postProcess);
      };

      self.registerUser = function(username, pass1, pass2, email) {
        var reg = {
          "username": username, "password1": pass2, "password2": pass2,
          "email": email
        };
        return $http.post(urlOf['rest-auth-register'], reg).then(extractData)
          .then(postProcess);
      };

      self.resetPassword = function(email) {
        return $http.post(urlOf['rest-auth-reset-password'], {email: email})
          .then(extractData).then(postProcess);
      };

      self.confirmResetPassword = function(uid, token, pass1, pass2) {
        var confirmation = {
          "uid": uid,
          "token": token,
          "new_password1": pass1,
          "new_password2": pass2
        };
        return $http.post(urlOf['rest-auth-confirm-reset'], confirmation)
          .then(extractData).then(postProcess);
      };
    }]);