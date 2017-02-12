var Web3 = require("web3");
var SolidityEvent = require("web3/lib/web3/event.js");

(function() {
  // Planned for future features, logging, etc.
  function Provider(provider) {
    this.provider = provider;
  }

  Provider.prototype.send = function() {
    this.provider.send.apply(this.provider, arguments);
  };

  Provider.prototype.sendAsync = function() {
    this.provider.sendAsync.apply(this.provider, arguments);
  };

  var BigNumber = (new Web3()).toBigNumber(0).constructor;

  var Utils = {
    is_object: function(val) {
      return typeof val == "object" && !Array.isArray(val);
    },
    is_big_number: function(val) {
      if (typeof val != "object") return false;

      // Instanceof won't work because we have multiple versions of Web3.
      try {
        new BigNumber(val);
        return true;
      } catch (e) {
        return false;
      }
    },
    merge: function() {
      var merged = {};
      var args = Array.prototype.slice.call(arguments);

      for (var i = 0; i < args.length; i++) {
        var object = args[i];
        var keys = Object.keys(object);
        for (var j = 0; j < keys.length; j++) {
          var key = keys[j];
          var value = object[key];
          merged[key] = value;
        }
      }

      return merged;
    },
    promisifyFunction: function(fn, C) {
      var self = this;
      return function() {
        var instance = this;

        var args = Array.prototype.slice.call(arguments);
        var tx_params = {};
        var last_arg = args[args.length - 1];

        // It's only tx_params if it's an object and not a BigNumber.
        if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
          tx_params = args.pop();
        }

        tx_params = Utils.merge(C.class_defaults, tx_params);

        return new Promise(function(accept, reject) {
          var callback = function(error, result) {
            if (error != null) {
              reject(error);
            } else {
              accept(result);
            }
          };
          args.push(tx_params, callback);
          fn.apply(instance.contract, args);
        });
      };
    },
    synchronizeFunction: function(fn, instance, C) {
      var self = this;
      return function() {
        var args = Array.prototype.slice.call(arguments);
        var tx_params = {};
        var last_arg = args[args.length - 1];

        // It's only tx_params if it's an object and not a BigNumber.
        if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
          tx_params = args.pop();
        }

        tx_params = Utils.merge(C.class_defaults, tx_params);

        return new Promise(function(accept, reject) {

          var decodeLogs = function(logs) {
            return logs.map(function(log) {
              var logABI = C.events[log.topics[0]];

              if (logABI == null) {
                return null;
              }

              var decoder = new SolidityEvent(null, logABI, instance.address);
              return decoder.decode(log);
            }).filter(function(log) {
              return log != null;
            });
          };

          var callback = function(error, tx) {
            if (error != null) {
              reject(error);
              return;
            }

            var timeout = C.synchronization_timeout || 240000;
            var start = new Date().getTime();

            var make_attempt = function() {
              C.web3.eth.getTransactionReceipt(tx, function(err, receipt) {
                if (err) return reject(err);

                if (receipt != null) {
                  // If they've opted into next gen, return more information.
                  if (C.next_gen == true) {
                    return accept({
                      tx: tx,
                      receipt: receipt,
                      logs: decodeLogs(receipt.logs)
                    });
                  } else {
                    return accept(tx);
                  }
                }

                if (timeout > 0 && new Date().getTime() - start > timeout) {
                  return reject(new Error("Transaction " + tx + " wasn't processed in " + (timeout / 1000) + " seconds!"));
                }

                setTimeout(make_attempt, 1000);
              });
            };

            make_attempt();
          };

          args.push(tx_params, callback);
          fn.apply(self, args);
        });
      };
    }
  };

  function instantiate(instance, contract) {
    instance.contract = contract;
    var constructor = instance.constructor;

    // Provision our functions.
    for (var i = 0; i < instance.abi.length; i++) {
      var item = instance.abi[i];
      if (item.type == "function") {
        if (item.constant == true) {
          instance[item.name] = Utils.promisifyFunction(contract[item.name], constructor);
        } else {
          instance[item.name] = Utils.synchronizeFunction(contract[item.name], instance, constructor);
        }

        instance[item.name].call = Utils.promisifyFunction(contract[item.name].call, constructor);
        instance[item.name].sendTransaction = Utils.promisifyFunction(contract[item.name].sendTransaction, constructor);
        instance[item.name].request = contract[item.name].request;
        instance[item.name].estimateGas = Utils.promisifyFunction(contract[item.name].estimateGas, constructor);
      }

      if (item.type == "event") {
        instance[item.name] = contract[item.name];
      }
    }

    instance.allEvents = contract.allEvents;
    instance.address = contract.address;
    instance.transactionHash = contract.transactionHash;
  };

  // Use inheritance to create a clone of this contract,
  // and copy over contract's static functions.
  function mutate(fn) {
    var temp = function Clone() { return fn.apply(this, arguments); };

    Object.keys(fn).forEach(function(key) {
      temp[key] = fn[key];
    });

    temp.prototype = Object.create(fn.prototype);
    bootstrap(temp);
    return temp;
  };

  function bootstrap(fn) {
    fn.web3 = new Web3();
    fn.class_defaults  = fn.prototype.defaults || {};

    // Set the network iniitally to make default data available and re-use code.
    // Then remove the saved network id so the network will be auto-detected on first use.
    fn.setNetwork("default");
    fn.network_id = null;
    return fn;
  };

  // Accepts a contract object created with web3.eth.contract.
  // Optionally, if called without `new`, accepts a network_id and will
  // create a new version of the contract abstraction with that network_id set.
  function Contract() {
    if (this instanceof Contract) {
      instantiate(this, arguments[0]);
    } else {
      var C = mutate(Contract);
      var network_id = arguments.length > 0 ? arguments[0] : "default";
      C.setNetwork(network_id);
      return C;
    }
  };

  Contract.currentProvider = null;

  Contract.setProvider = function(provider) {
    var wrapped = new Provider(provider);
    this.web3.setProvider(wrapped);
    this.currentProvider = provider;
  };

  Contract.new = function() {
    if (this.currentProvider == null) {
      throw new Error("Pensions error: Please call setProvider() first before calling new().");
    }

    var args = Array.prototype.slice.call(arguments);

    if (!this.unlinked_binary) {
      throw new Error("Pensions error: contract binary not set. Can't deploy new instance.");
    }

    var regex = /__[^_]+_+/g;
    var unlinked_libraries = this.binary.match(regex);

    if (unlinked_libraries != null) {
      unlinked_libraries = unlinked_libraries.map(function(name) {
        // Remove underscores
        return name.replace(/_/g, "");
      }).sort().filter(function(name, index, arr) {
        // Remove duplicates
        if (index + 1 >= arr.length) {
          return true;
        }

        return name != arr[index + 1];
      }).join(", ");

      throw new Error("Pensions contains unresolved libraries. You must deploy and link the following libraries before you can deploy a new version of Pensions: " + unlinked_libraries);
    }

    var self = this;

    return new Promise(function(accept, reject) {
      var contract_class = self.web3.eth.contract(self.abi);
      var tx_params = {};
      var last_arg = args[args.length - 1];

      // It's only tx_params if it's an object and not a BigNumber.
      if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
        tx_params = args.pop();
      }

      tx_params = Utils.merge(self.class_defaults, tx_params);

      if (tx_params.data == null) {
        tx_params.data = self.binary;
      }

      // web3 0.9.0 and above calls new twice this callback twice.
      // Why, I have no idea...
      var intermediary = function(err, web3_instance) {
        if (err != null) {
          reject(err);
          return;
        }

        if (err == null && web3_instance != null && web3_instance.address != null) {
          accept(new self(web3_instance));
        }
      };

      args.push(tx_params, intermediary);
      contract_class.new.apply(contract_class, args);
    });
  };

  Contract.at = function(address) {
    if (address == null || typeof address != "string" || address.length != 42) {
      throw new Error("Invalid address passed to Pensions.at(): " + address);
    }

    var contract_class = this.web3.eth.contract(this.abi);
    var contract = contract_class.at(address);

    return new this(contract);
  };

  Contract.deployed = function() {
    if (!this.address) {
      throw new Error("Cannot find deployed address: Pensions not deployed or address not set.");
    }

    return this.at(this.address);
  };

  Contract.defaults = function(class_defaults) {
    if (this.class_defaults == null) {
      this.class_defaults = {};
    }

    if (class_defaults == null) {
      class_defaults = {};
    }

    var self = this;
    Object.keys(class_defaults).forEach(function(key) {
      var value = class_defaults[key];
      self.class_defaults[key] = value;
    });

    return this.class_defaults;
  };

  Contract.extend = function() {
    var args = Array.prototype.slice.call(arguments);

    for (var i = 0; i < arguments.length; i++) {
      var object = arguments[i];
      var keys = Object.keys(object);
      for (var j = 0; j < keys.length; j++) {
        var key = keys[j];
        var value = object[key];
        this.prototype[key] = value;
      }
    }
  };

  Contract.all_networks = {
  "default": {
    "abi": [
      {
        "constant": false,
        "inputs": [],
        "name": "getPensionerInfo",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "owner",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [],
        "name": "Terminate",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "balance",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "acc",
            "type": "address"
          },
          {
            "name": "name",
            "type": "bytes"
          },
          {
            "name": "addr",
            "type": "bytes"
          },
          {
            "name": "bsn",
            "type": "uint256"
          },
          {
            "name": "dob",
            "type": "uint256"
          }
        ],
        "name": "createPensioner",
        "outputs": [
          {
            "name": "",
            "type": "bool"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "name": "pensioner",
        "outputs": [
          {
            "name": "acc",
            "type": "address"
          },
          {
            "name": "name",
            "type": "bytes"
          },
          {
            "name": "addr",
            "type": "bytes"
          },
          {
            "name": "bsn",
            "type": "uint256"
          },
          {
            "name": "dob",
            "type": "uint256"
          },
          {
            "name": "balance",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "inputs": [
          {
            "name": "acc",
            "type": "address"
          },
          {
            "name": "name",
            "type": "bytes"
          },
          {
            "name": "addr",
            "type": "bytes"
          },
          {
            "name": "bsn",
            "type": "uint256"
          },
          {
            "name": "dob",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "constructor"
      },
      {
        "payable": true,
        "type": "fallback"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "owner",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "balance",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "pensioner_acc",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "pensioner_name",
            "type": "bytes"
          },
          {
            "indexed": false,
            "name": "pensioner_addr",
            "type": "bytes"
          },
          {
            "indexed": false,
            "name": "pensioner_bsn",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "pensioner_dob",
            "type": "uint256"
          }
        ],
        "name": "Pensions_ev",
        "type": "event"
      }
    ],
    "unlinked_binary": "0x6060604052346100005760405161089838038061089883398101604090815281516020830151918301516060840151608085015192949384019391909101915b600080546c01000000000000000000000000338102819004600160a060020a0319928316178355606360065560018054898302929092049190921617815585516002805493819052926020601f93821615610100026000190190911684900483018190047f405787fa12a823e0f2b7631cc41b3ba8828b3321ca811111fa75cd3aa3bb5ace9081019390918901908390106100e557805160ff1916838001178555610112565b82800160010185558215610112579182015b828111156101125782518255916020019190600101906100f7565b5b506101339291505b8082111561012f576000815560010161011b565b5090565b50508260039080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f1061018157805160ff19168380011785556101ae565b828001600101855582156101ae579182015b828111156101ae578251825591602001919060010190610193565b5b506101cf9291505b8082111561012f576000815560010161011b565b5090565b5050600482905560058190556000546006546001805460408051600160a060020a03958616808252602082018690529590921690820181905260a0820187905260c0820186905260e0606083018181526002805461010096811615870260001901168190049285018390527ff372c8f0d111aaf7429d5a9064ecc4abb3e50f5d25e43c52d411bea82e273e9a979695939490936003938b938b939290916080840191840190889080156102c35780601f10610298576101008083540402835291602001916102c3565b820191906000526020600020905b8154815290600101906020018083116102a657829003601f168201915b50508381038252865460026000196101006001841615020190911604808252602090910190879080156103375780601f1061030c57610100808354040283529160200191610337565b820191906000526020600020905b81548152906001019060200180831161031a57829003601f168201915b5050995050505050505050505060405180910390a15b50505050505b610537806103616000396000f3606060405236156100565760e060020a60003504636bca1d7a811461006d5780638da5cb5b1461008c5780639445eb3a146100b5578063b69ef8a8146100c4578063c2a47244146100e3578063ed83350a1461018f575b61006b5b600034111561006857346006555b5b565b005b346100005761007a6102ca565b60408051918252519081900360200190f35b34610000576100996102d1565b60408051600160a060020a039092168252519081900360200190f35b346100005761006b6102e0565b005b346100005761007a610309565b60408051918252519081900360200190f35b346100005760408051602060046024803582810135601f810185900485028601850190965285855261017b958335959394604494939290920191819084018382808284375050604080516020601f89358b018035918201839004830284018301909452808352979998810197919650918201945092508291508401838280828437509496505084359460200135935061030f92505050565b604080519115158252519081900360200190f35b346100005761019f6004356104fc565b60408051600160a060020a0388168152606081018590526080810184905260a0810183905260c060208201818152885460026000196101006001841615020190911604918301829052919283019060e0840190899080156102415780601f1061021657610100808354040283529160200191610241565b820191906000526020600020905b81548152906001019060200180831161022457829003601f168201915b50508381038252875460026000196101006001841615020190911604808252602090910190889080156102b55780601f1061028a576101008083540402835291602001916102b5565b820191906000526020600020905b81548152906001019060200180831161029857829003601f168201915b50509850505050505050505060405180910390f35b6006545b90565b600054600160a060020a031681565b60005433600160a060020a039081169116141561006857600054600160a060020a0316ff5b5b5b565b60065481565b6040805160c0810182528681526020808201878152828401879052606083018690526080830185905260065460a0840152600160a060020a0389166000908152600783529384208351815473ffffffffffffffffffffffffffffffffffffffff19166c0100000000000000000000000091820291909104178155905180516001808401805481895286892095969195600261010094831615949094026000190190911692909204601f908101829004830194909101908390106103dd57805160ff191683800117855561040a565b8280016001018555821561040a579182015b8281111561040a5782518255916020019190600101906103ef565b5b5061042b9291505b808211156104275760008155600101610413565b5090565b50506040820151816002019080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f1061047f57805160ff19168380011785556104ac565b828001600101855582156104ac579182015b828111156104ac578251825591602001919060010190610491565b5b506104cd9291505b808211156104275760008155600101610413565b5090565b5050606082015160038201556080820151600482015560a0909101516005909101555060015b95945050505050565b60076020526000908152604090208054600382015460048301546005840154600160a060020a0390931693600181019360029091019291908656",
    "events": {
      "0xf372c8f0d111aaf7429d5a9064ecc4abb3e50f5d25e43c52d411bea82e273e9a": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "owner",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "balance",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "pensioner_acc",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "pensioner_name",
            "type": "bytes"
          },
          {
            "indexed": false,
            "name": "pensioner_addr",
            "type": "bytes"
          },
          {
            "indexed": false,
            "name": "pensioner_bsn",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "pensioner_dob",
            "type": "uint256"
          }
        ],
        "name": "Pensions_ev",
        "type": "event"
      }
    },
    "updated_at": 1486879950250,
    "links": {},
    "address": "0xcbc09888bad00a4f0579cf2f2b7a0fde827f83aa"
  }
};

  Contract.checkNetwork = function(callback) {
    var self = this;

    if (this.network_id != null) {
      return callback();
    }

    this.web3.version.network(function(err, result) {
      if (err) return callback(err);

      var network_id = result.toString();

      // If we have the main network,
      if (network_id == "1") {
        var possible_ids = ["1", "live", "default"];

        for (var i = 0; i < possible_ids.length; i++) {
          var id = possible_ids[i];
          if (Contract.all_networks[id] != null) {
            network_id = id;
            break;
          }
        }
      }

      if (self.all_networks[network_id] == null) {
        return callback(new Error(self.name + " error: Can't find artifacts for network id '" + network_id + "'"));
      }

      self.setNetwork(network_id);
      callback();
    })
  };

  Contract.setNetwork = function(network_id) {
    var network = this.all_networks[network_id] || {};

    this.abi             = this.prototype.abi             = network.abi;
    this.unlinked_binary = this.prototype.unlinked_binary = network.unlinked_binary;
    this.address         = this.prototype.address         = network.address;
    this.updated_at      = this.prototype.updated_at      = network.updated_at;
    this.links           = this.prototype.links           = network.links || {};
    this.events          = this.prototype.events          = network.events || {};

    this.network_id = network_id;
  };

  Contract.networks = function() {
    return Object.keys(this.all_networks);
  };

  Contract.link = function(name, address) {
    if (typeof name == "function") {
      var contract = name;

      if (contract.address == null) {
        throw new Error("Cannot link contract without an address.");
      }

      Contract.link(contract.contract_name, contract.address);

      // Merge events so this contract knows about library's events
      Object.keys(contract.events).forEach(function(topic) {
        Contract.events[topic] = contract.events[topic];
      });

      return;
    }

    if (typeof name == "object") {
      var obj = name;
      Object.keys(obj).forEach(function(name) {
        var a = obj[name];
        Contract.link(name, a);
      });
      return;
    }

    Contract.links[name] = address;
  };

  Contract.contract_name   = Contract.prototype.contract_name   = "Pensions";
  Contract.generated_with  = Contract.prototype.generated_with  = "3.2.0";

  // Allow people to opt-in to breaking changes now.
  Contract.next_gen = false;

  var properties = {
    binary: function() {
      var binary = Contract.unlinked_binary;

      Object.keys(Contract.links).forEach(function(library_name) {
        var library_address = Contract.links[library_name];
        var regex = new RegExp("__" + library_name + "_*", "g");

        binary = binary.replace(regex, library_address.replace("0x", ""));
      });

      return binary;
    }
  };

  Object.keys(properties).forEach(function(key) {
    var getter = properties[key];

    var definition = {};
    definition.enumerable = true;
    definition.configurable = false;
    definition.get = getter;

    Object.defineProperty(Contract, key, definition);
    Object.defineProperty(Contract.prototype, key, definition);
  });

  bootstrap(Contract);

  if (typeof module != "undefined" && typeof module.exports != "undefined") {
    module.exports = Contract;
  } else {
    // There will only be one version of this contract in the browser,
    // and we can use that.
    window.Pensions = Contract;
  }
})();
