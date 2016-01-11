// dingo.js
// 
// An implementation of a Chaos Monkey for Azure using the Azure NodeJS SDK.
// This application currently has the following assumptions:
//
//      1 - The resources the application should operate against are
//          Azure Resource Manager (ARM) based resources, in otherwords, the
//          application uses the newer Azure APIs.
//
//          Details about ARM is here: https://azure.microsoft.com/en-us/documentation/articles/resource-group-overview/
//
//      2 - Operations are performed by a Service Principal tied to an Active
//          Directory associated with the subscription.
//
//          More about creating a Service Principal can be found here:
//          https://azure.microsoft.com/en-us/documentation/articles/resource-group-authenticate-service-principal/
//
//          Note, currently only the password method is supported.

// modules
var adalNode = require('adal-node');
var async = require('async');
var azureCommon = require('azure-common');
var ComputeManagementClient = require('azure-arm-compute');

var armCompute = require('./arm_compute_ops');
var azureConstants = require('./azure_constants');
var dingoUtils = require('./dingo_utils');

var operationTimeout = 60;  // time to wait before we timeout of an operation

var options = require('yargs')
    .usage('Usage $0 [options]')
    .option('t', { alias: 'tenant', describe: 'Tenant ID.', demand: true, type: 'string' } )
    .option('s', { alias: 'subscription', describe: 'Subscription ID.', demand: true, type: 'string' } )
    .option('c', { alias: 'client', describe: 'Client ID.', demand: true, type: 'string' } )
    .option('p', { alias: 'password', describe: 'Secret associated with the Client ID.', demand: true, type: 'string' } )
    .option('g', { alias: 'resourcegrp', describe: 'The resource group to operate in.', demand: true, type: 'string' } )
    .option('r', { alias: 'resource', describe: 'The name of the resource to operate on.', type: 'string' } )
    .option('a', { alias: 'randomresource', describe: 'Choose a resource at random from the resource group.  (Limited to VMs)', type: 'boolean' })
    .option('o', { alias: 'operation', describe: 'The operation to perform on the specified resource.  Possible are: start, stop, restart, powercycle.', demand: true, type: 'string' })
    .option('m', { alias: 'resourcematch', describe: 'A regular expression to match / filter the list of random resources.', type: 'string' })
    .option('d', {  alias: 'delay', describe: 'The delay to wait between operations which require two steps.  Can be an integer or a range (range will be random in the range).  Default will be 60 seconds.', type: 'string' })
    .help('?')
    .alias('?', 'help')
    .argv;

if(!options.tenant ||
        !options.subscription ||
        !options.client ||
        !options.password ||
        !options.resourcegrp) {
    process.exit(1);
} else if(!options.randomresource && !options.resource) {
    console.log("Either a resource is required or select one at random.");
    process.exit(1);
} else if(options.randomresource && options.resource) {
    console.log("Can not specify choose a random resource and specify an actual resource.");
    process.exit(1);
} else if(options.resource && options.resourcematch) {
    console.log("Can not specify a resource match pattern when specifying a specific resource.");
    process.exit(1);
}

var vmFunctionBegin = null;
var vmFunctionEnd = null;
var operationDelay;
switch(options.operation) {
    case 'start':
        vmFunction = armCompute.vmOperations.start_vm;
        break;
    case 'stop':
        vmFunction = armCompute.vmOperations.stop_vm;
        break;
    case 'restart':
        vmFunction = armCompute.vmOperations.restart_vm;
        break;
    case 'powercycle':
        vmFunctionBegin = armCompute.vmOperations.stop_vm;
        vmFunctionEnd = armCompute.vmOperations.start_vm;
        break;
    default:
        throw new Error('Unsupported operation.  Operation: ' + options.operation);
}

// if we have a compound operation (powercycle, for instance), then 
// check for duration to wait between start and end.  If no value 
// specified, the default is 60 seconds.
if(vmFunctionEnd) {
    if(options.delay) {
        var a = parseInt(options.delay);
        if(a.toString() == options.delay) {
            operationDelay = a;
        } else {
            var range = options.delay.split('-');
            if(range.length == 2) {
                if((parseInt((range[0]).toString() != range[0])) ||
                        (parseInt(range[1]).toString() != range[1])) {
                    console.log('A duration range requires two numbers of the form X-Y.');
                    process.exit(1);
                } else {
                    var min = parseInt(range[0]), max = parseInt(range[1]);
                    if((max < min) || (max == min)) {
                        console.log('A range must be specified as MIN-MAX, and the two values can not be equal.');
                        process.exit(1);
                    }
                    operationDelay = Math.floor(Math.random() * (max - min)) + min;
                }
            }
        }
    } else {
        operationDelay = 60;
    }
}

// Functions and variables to control activity on resources.
// It is assumed they are placed into an async.series.
var client;
var response;
var credentials;
var resource;

function process_authenticate_user(next) {

    console.log("Acquiring token.");    
    var context = new adalNode.AuthenticationContext(azureConstants.AUTHORIZATION_ENDPOINT + options.tenant);
    context.acquireTokenWithClientCredentials(azureConstants.ARM_RESOURCE_ENDPOINT, 
                                              options.client, 
                                              options.password,
                                              function(err, result){
        if (err) throw err;
        response = result;
        next();
    });
}

function process_gather_credentials(next) { 
    console.log("Gathering credentials.");
    credentials = new azureCommon.TokenCloudCredentials({
            subscriptionId : options.subscription,
            authorizationScheme : response.tokenType,
            token : response.accessToken
    });
    next();
}

function process_generate_client(next) {
    console.log("Generate client.");
    client = new ComputeManagementClient(credentials, options.subscription);
    next();
}


function process_determine_resource(next) {
    if(options.randomresource) {
        armCompute.vmInfoOperations.list_vms(client, options.resourcegrp, function(err, result) {
            if(err) {
                throw err;
            } else {
                dingoUtils.parse_vm_list(result, function(err, result) {
                    if(err) {
                        throw err;
                    } else {
                        // Check to see if the list of resources is filtered by name
                        if(options.resourcematch) {
                            var vms = result;
                            dingoUtils.filter_vm_list(options.resourcematch, vms, function(err, result) {
                                if(err) {
                                    throw err;
                                } else {
                                    if(result.length == 0) {
                                        throw new Error('No resources matched.');
                                    } else {
                                        var tmp = dingoUtils.random_array_entry(result)
                                        for(var i = 0; i < vms.length; i++) {
                                            if(vms[i] == tmp) {
                                                resource = tmp;
                                                break;
                                            }
                                        }
                                        if(!resource) {
                                            throw new Error('Resource match pattern specified did not find a valid resource');
                                        }
                                    }
                                } 
                            });
                        } else {
                            resource = dingoUtils.random_array_entry(result);
                        }
                    }
                });
            }
            console.log("Resource to perform operation on: " + resource);
            next();
        });    
    } else {
        resource = options.resource;
        console.log("Resource to perform operation on: " + resource);
    }
}

function process_perform_begin_operation(next) {
    console.log("Start operation: " + options.operation);
    vmFunctionBegin(client, options.resourcegrp, resource, function(err, result) {
        if(err) {
            throw err;            
        } else {
            console.log("Operation " + options.operation + " succeeded.");
        }
        if(next) {
            next();
        }
    });
}

function process_pause_between_operations(next) {
    console.log("Pausing for " + operationDelay + " seconds.");
    setTimeout(function() {
                    next();
                }, operationDelay * 1000);
}

function process_perform_end_operation(next) {
    console.log("Finishing operation: " + options.operation);
    vmFunctionEnd(client, options.resourcegrp, resource, function(err, result) {
        if(err) {
            throw err;
        } else {
            console.log("Finishing operation " + options.operation + " succeeded.");
        }
        if(next) {
            next();
        }
    });
}

asyncOps = [
    process_authenticate_user,
    process_gather_credentials,
    process_generate_client,
    process_determine_resource,
    process_perform_begin_operation
];

// Do we have an operation that has a begin and an end?  If so, then
// add the pause and end operation steps.
if(vmFunctionEnd) {
    asyncOps.push(process_pause_between_operations);
    asyncOps.push(process_perform_end_operation);
}

async.series(asyncOps);