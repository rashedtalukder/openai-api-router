/**
 * Name: Azure OAI processor
 * Description: This class implements a processor for executing Azure Open AI API requests.
 *
 * Author: Ganesh Radhakrishnan (ganrad01@gmail.com)
 * Date: 04-24-2024
 *
 * Notes:
 * ID04272024: ganrad: Centralized logging with winstonjs
 * ID05062024: ganrad: Introduced memory feature (state management) for appType = Azure OpenAI Service
 *
*/
const path = require('path');
const scriptName = path.basename(__filename);
const logger = require('../utilities/logger');

const fetch = require("node-fetch");
const CacheDao = require("../utilities/cache-dao.js"); // ID02202024.n
const cachedb = require("../services/cp-pg.js"); // ID02202024.n
const { TblNames, PersistDao } = require("../utilities/persist-dao.js"); // ID03012024.n
const persistdb = require("../services/pp-pg.js"); // ID03012024.n
const pgvector = require("pgvector/pg"); // ID02202024.n
const { CustomRequestHeaders } = require("../utilities/app-gtwy-constants.js"); // ID05062024.n
const { randomUUID } = require('node:crypto'); // ID05062024.n

class AzOaiProcessor {

  constructor() {
  }

  #checkAndPruneCtxMsgs(count,msgs) {
    let aCount = 3 + (count * 2);
    
    let mLength = msgs.length;

    if ( mLength > aCount )
      msgs.splice(3,2); // keep the original system + prompt and completion

    return(msgs)
  }

  async processRequest(
    req, // 0
    config) { // 1

    let apps = req.targeturis; // Ai applications object
    let cacheConfig = req.cacheconfig; // global cache config
    let memoryConfig = arguments[2]; // AI application state management config ID05062024.n
    let appConnections = arguments[3]; // EP metrics obj for all apps
    let cacheMetrics = arguments[4]; // Cache hit metrics obj for all apps
    let manageState = (process.env.API_GATEWAY_STATE_MGMT === 'true') ? true : false
	
    // State management is only supported for chat completion API!
    if ( memoryConfig && (! req.body.messages) ) // If the request is not of type == chat completion
      memoryConfig = null;

    // 1. Check thread ID in request header
    let threadId = req.get(CustomRequestHeaders.ThreadId);

    // console.log(`*****\nAzOaiProcessor.processRequest():\n  URI: ${req.originalUrl}\n  Request ID: ${req.id}\n  Application ID: ${config.appId}\n  Type: ${config.appType}`);
    logger.log({level: "info", message: "[%s] %s.processRequest(): Request ID: %s\n  URL: %s\n  Thread ID: %s\n  Application ID: %s\n  Type: %s\n Request Payload: %s", splat: [scriptName,this.constructor.name,req.id,req.originalUrl,threadId,config.appId,config.appType,JSON.stringify(req.body)]});
    
    let respMessage = null; // Populate this var before returning!

    // 2. Check prompt present in cache
    // Has caching been disabled on the request using query param ~
    // 'use_cache=false' ?
    let useCache = config.useCache;
    if ( useCache && req.query.use_cache )
      useCache = req.query.use_cache === 'false' ? false : useCache;

    let vecEndpoints = null;
    let embeddedPrompt = null;
    let cacheDao = null;
    let memoryDao = null;
    let values = null;
    let err_msg = null;

    if (! threadId) { 
      if ( cacheConfig.cacheResults && useCache ) { // Is caching enabled?
        for ( const application of apps.applications) {
          if ( application.appId == cacheConfig.embeddApp ) {
            vecEndpoints = application.endpoints;

            break;
          };
        };

        // Perform semantic search using input prompt
        cacheDao = new CacheDao(
          appConnections.getConnection(cacheConfig.embeddApp),
          vecEndpoints,
          config.srchType,
          config.srchDistance,
          config.srchContent);

        const {rowCount, simScore, completion, embeddings} =
          await cacheDao.queryVectorDB(
            req.id,
            config.appId,
            req.body,
            cachedb
          );

        if ( rowCount === 1 ) { // Cache hit!
          cacheMetrics.updateCacheMetrics(config.appId, simScore);

	  respMessage = {
	    http_code: 200, // All ok. Serving completion from cache.
	    cached: true,
	    data: completion
	  };

          if ( manageState && memoryConfig && memoryConfig.useMemory ) { // Manage state for this AI application?
	    threadId = randomUUID();
            respMessage.threadId = threadId;

            req.body.messages.push(completion.choices[0].message); 
            logger.log({level: "debug", message: "[%s] %s.processRequest():\n  Request ID: %s\n  Thread ID: %s\n  Prompt + Cached Message: %s", splat: [scriptName,this.constructor.name,req.id,threadId,JSON.stringify(req.body.messages)]});

            memoryDao = new PersistDao(persistdb, TblNames.Memory);
            values = [
              req.id,
              threadId,
              config.appId,
	      {
	        content: req.body.messages
	      },
	      req.body.user // ID04112024.n
            ];

            await memoryDao.storeEntity(0,values);
	  };

          return(respMessage);
        }
        else
          embeddedPrompt = embeddings;
      }
    }
    else { // Start of user session if
      memoryDao = new PersistDao(persistdb, TblNames.Memory);
      values = [
        threadId,
        config.appId
      ];
      
      // retrieve the thread context
      const userContext = await memoryDao.queryTable(req.id,0,values)
      if ( userContext.rCount === 1 ) {
	let inMsgs = req.body.messages;
	let ctxContent = userContext.data[0].context.content;
	let ctxMsgs = ctxContent.concat(req.body.messages);

	if ( memoryConfig.msgCount >= 1 ) 
	  this.#checkAndPruneCtxMsgs(memoryConfig.msgCount, ctxMsgs);

	req.body.messages = ctxMsgs;

        logger.log({level: "debug", message: "[%s] %s.processRequest():\n  Request ID: %s\n  Thread ID: %s\n  Prompt + Retrieved Message: %s", splat: [scriptName,this.constructor.name,req.id,threadId,JSON.stringify(req.body.messages)]});
      }
      else {
        err_msg = {
          endpointUri: req.originalUrl,
          currentDate: new Date().toLocaleString(),
          errorMessage: `The user session associated with Thread ID=[${threadId}] has either expired or is invalid! Start a new user session.`
        };

	respMessage = {
	  http_code: 400, // Bad request
	  data: err_msg
	};

	return(respMessage);
      };
    }; // end of user session if

    // 3. Call Azure OAI endpoint(s)
    let epdata = appConnections.getConnection(config.appId);
    let stTime = Date.now();

    let response;
    let retryAfter = 0;
    let data;
    for (const element of config.appEndpoints) { // start of endpoint loop
      let metricsObj = epdata.get(element.uri); 
      let healthArr = metricsObj.isEndpointHealthy();
      // console.log(`******isAvailable=${healthArr[0]}; retryAfter=${healthArr[1]}`);
      if ( ! healthArr[0] ) {
        if ( retryAfter > 0 )
  	  retryAfter = (healthArr[1] < retryAfter) ? healthArr[1] : retryAfter;
	else
	  retryAfter = healthArr[1];
        continue;
      };

      try {
        const meta = new Map();
        meta.set('Content-Type','application/json');
        meta.set('api-key',element.apikey);

        response = await fetch(element.uri, {
          method: req.method,
	  headers: meta,
          body: JSON.stringify(req.body)
        });

        // let { status, statusText, headers } = response;
	let status = response.status;
        if ( status === 200 ) { // All Ok
          data = await response.json();

          let respTime = Date.now() - stTime;
	  metricsObj.updateApiCallsAndTokens(
            data.usage.total_tokens,
            respTime);

          // ID02202024.sn
          if ( (! threadId) && cacheDao && embeddedPrompt ) { // Cache results ?
            let prompt = req.body.prompt;
            if ( ! prompt )
              prompt = JSON.stringify(req.body.messages);

            let values = [
              req.id,
              config.appId,
              prompt,
              pgvector.toSql(embeddedPrompt),
              data
            ];

            await cacheDao.storeEntity(
              0,
              values,
              cachedb
            );
          };
          // ID02202024.en

          // ID03012024.sn
          let persistPrompts = (process.env.API_GATEWAY_PERSIST_PROMPTS === 'true') ? true : false
          if ( persistPrompts ) { // Persist prompts ?
            let promptDao = new PersistDao(persistdb, TblNames.Prompts);
            let values = [
              req.id,
              config.appId,
              req.body,
	      data, // ID04112024.n
	      req.body.user // ID04112024.n
            ];

            await promptDao.storeEntity(
              0,
              values
            );
          };
          // ID03012024.en

	  respMessage = {
	    http_code: status,
	    cached: false,
	    data: data
	  };

          // return(respMessage);
	  break; // break out from the endpoint loop!
        }
        else if ( status === 429 ) { // endpoint is busy so try next one
          data = await response.json();

	  let retryAfterSecs = response.headers.get('retry-after');
	  // let retryAfterMs = headers.get('retry-after-ms');

	  if ( retryAfter > 0 )
	    retryAfter = (retryAfterSecs < retryAfter) ? retryAfterSecs : retryAfter;
	  else
	    retryAfter = retryAfterSecs;

	  metricsObj.updateFailedCalls(status,retryAfterSecs);

          // console.log(`*****\nAzOaiProcessor.processRequest():\n  App Id: ${config.appId}\n  Request ID: ${req.id}\n  Target Endpoint: ${element.uri}\n  Status: ${status}\n  Message: ${JSON.stringify(data)}\n  Status Text: ${statusText}\n  Retry seconds: ${retryAfterSecs}\n*****`);
	  logger.log({level: "warn", message: "[%s] %s.processRequest():\n  App Id: %s\n  Request ID: %s\n  Target Endpoint: %s\n  Status: %s\n  Status Text: %s\n  Message: %s\n  Retry seconds: %d", splat: [scriptName,this.constructor.name,config.appId,req.id,element.uri,status,response.statusText,JSON.stringify(data),retryAfterSecs]});
        }
        else if ( status === 400 ) { // Invalid prompt ~ content filtered
          data = await response.json();

          // ID03012024.sn
          let persistPrompts = (process.env.API_GATEWAY_PERSIST_PROMPTS === 'true') ? true : false
          if ( persistPrompts ) { // Persist prompts ?
            let promptDao = new PersistDao(persistdb, TblNames.Prompts);
            let values = [
              req.id,
              config.appId,
              req.body,
	      data, // ID04112024.n
	      req.body.user // ID04112024.n
            ];

            await promptDao.storeEntity(
              0,
              values
            );
          };
          // ID03012024.en

          // console.log(`*****\nAzOaiProcessor.processRequest():\n  App Id: ${config.appId}\n  Request ID: ${req.id}\n  Target Endpoint: ${element.uri}\n  Status: ${status}\n  Message: ${JSON.stringify(data)}\n  Status Text: ${statusText}\n*****`);
	  logger.log({level: "warn", message: "[%s] %s.processRequest():\n  App Id: %s\n  Request ID: %s\n  Target Endpoint: %s\n  Status: %s\n  Status Text: %s\n  Message: %s", splat: [scriptName,this.constructor.name,config.appId,req.id,element.uri,status,response.statusText,JSON.stringify(data)]});

	  metricsObj.updateFailedCalls(status,0);
	  respMessage = {
	    http_code: status,
	    status_text: response.statusText,
	    data: data
	  };

          break;
        }
        else { // Authz failed
          data = await response.text();

          // console.log(`*****\nAzOaiProcessor.processRequest():\n  App Id: ${config.appId}\n  Request ID: ${req.id}\n  Target Endpoint: ${element.uri}\n  Status: ${status}\n  Message: ${JSON.stringify(data)}\n*****`);
	  logger.log({level: "warn", message: "[%s] %s.processRequest():\n  App Id: %s\n  Request ID: %s\n  Target Endpoint: %s\n  Status: %s\n  Status Text: %s\n  Message: %s", splat: [scriptName,this.constructor.name,config.appId,req.id,element.uri,status,response.statusText,JSON.stringify(data)]});

	  metricsObj.updateFailedCalls(status,0);

	  err_msg = {
            appId: config.appId,
            reqId: req.id,
            targetUri: element.uri,
            http_code: status,
	    status_text: response.statusText,
	    data: data,
            cause: `AI Service endpoint returned exception message [${response.statusText}]`
          };
	
	  respMessage = {
	    http_code: status,
	    data: err_msg
	  };
        };
      }
      catch (error) {
        err_msg = {
	  appId: config.appId,
	  reqId: req.id,
	  targetUri: element.uri,
	  cause: error
	};
        // console.log(`*****\nAzOaiProcessor.processRequest():\n  Encountered exception:\n  ${JSON.stringify(err_msg)}\n*****`)
	logger.log({level: "error", message: "[%s] %s.processRequest():\n  Encountered exception:\n  %s", splat: [scriptName,this.constructor.name,err_msg]});

	respMessage = {
          http_code: 500,
	  data: err_msg
	};

        break; // ID04172024.n
      };
    }; // end of endpoint loop

    // instanceFailedCalls++;

    if ( retryAfter > 0 ) {
      err_msg = {
        endpointUri: req.originalUrl,
        currentDate: new Date().toLocaleString(),
        errorMessage: `All backend OAI endpoints are too busy! Retry after [${retryAfter}] seconds ...`
      };

      // res.set('retry-after', retryAfter); // Set the retry-after response header
      respMessage = {
        http_code: 429, // Server is busy, retry later!
        data: err_msg,
	retry_after: retryAfter
      };
    }
    else {
      if ( respMessage == null ) {
        err_msg = {
          endpointUri: req.originalUrl,
          currentDate: new Date().toLocaleString(),
          errorMessage: "Internal server error. Unable to process request. Check server logs."
        };
	respMessage = {
	  http_code: 500, // Internal API Gateway server error!
	  data: err_msg
	};
      };
    };

    // ID05062024.sn
    if ( (respMessage.http_code === 200) && manageState && memoryConfig && memoryConfig.useMemory ) { // Manage state for this AI application?

      let completionMsg = {
	role: data.choices[0].message.role,
	content: data.choices[0].message.content
      };

      req.body.messages.push(completionMsg); 

      memoryDao = new PersistDao(persistdb, TblNames.Memory);
      if ( ! threadId )
	threadId = randomUUID();

      logger.log({level: "debug", message: "[%s] %s.processRequest():\n  Request ID: %s\n  Thread ID: %s\n  Completed Message: %s", splat: [scriptName,this.constructor.name,req.id,threadId,JSON.stringify(req.body.messages)]});
	
      values = [
        req.id,
        threadId,
        config.appId,
        {
          content: req.body.messages
	},
	req.body.user // ID04112024.n
      ];

      if ( req.get(CustomRequestHeaders.ThreadId) ) // Update
	await memoryDao.storeEntity(1,values);
      else // Insert
        await memoryDao.storeEntity(0,values);

      respMessage.threadId = threadId;
    };
    // ID05062024.en

    return(respMessage);
  } // end of processRequest()
}

module.exports = AzOaiProcessor;
