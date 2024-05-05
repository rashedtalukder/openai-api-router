/**
 * Name: AzOaiEpMetrics
 * Description: This class collects OAI API endpoint metrics and stores them in a 
 * light-weight data structure (~ Queue).
 *
 * Author: Ganesh Radhakrishnan (ganrad01@gmail.com)
 * Date: 01-28-2024
 *
 * Notes:
 * ID04272024: ganrad: Centralized logging with winstonjs
 * ID05042024: ganrad: Added additional endpoint metrics - throttledApiCalls, filteredApiCalls, tokensPerMinute and requestsPerMinute
 *
*/
const path = require('path');
const scriptName = path.basename(__filename);
const logger = require('./logger');

const Queue = require('./queue');
const { EndpointMetricsConstants } = require('./app-gtwy-constants');

class AzOaiEpMetrics {
  constructor(endpoint,interval,count) {
    this.endpoint = endpoint; // The target endpoint
    this.apiCalls = 0; // No. of successful calls
    this.failedCalls = 0; // No. of failed calls ~ 429's
    this.totalCalls = 0; // Total calls handled by this target endpoint
    this.totalTokens = 0; // Total tokens processed by this target endpoint
    
    this.throttledCalls = 0; // Throttled (429) API calls - ID05042024.n
    this.filteredCalls = 0; // Api calls to which content filters (400) were applied - ID05042024.n

    this.timeMarker = Date.now(); // Time marker used to check if endpoint is unhealthy

    if ( interval )
      this.cInterval = Number(interval); // Metrics collection interval
    else
      this.cInterval = EndpointMetricsConstants.DEF_METRICS_C_INTERVAL;

    if ( count )
      this.hStack = Number(count); // Metrics history cache count
    else
      this.hStack = EndpointMetricsConstants.DEF_METRICS_H_COUNT;
    // console.log(`\n  Endpoint:  ${this.endpoint}\n  Cache Interval (minutes): ${this.cInterval}\n  History Count: ${this.hStack}`);
    logger.log({level: "info", message: "[%s] %s.constructor():\n  Endpoint:  %s\n  Cache Interval (minutes): %d\n  History Count: %d", splat: [scriptName,this.constructor.name,this.endpoint,this.cInterval,this.hStack]});

    this.startTime = Date.now();
    this.endTime = this.startTime + (this.cInterval * 60 * 1000);

    this.respTime = 0; // Average api call response time for a cInterval
    this.historyQueue = new Queue(count); // Metrics history cache (fifo queue)
  }

  isEndpointHealthy() {
    let currentTime = Date.now();

    let isAvailable = currentTime >= this.timeMarker;
    let retrySecs = isAvailable ? 0 : (this.timeMarker - currentTime) / 1000;
    return [isAvailable, retrySecs];
  }

  updateApiCallsAndTokens(tokens, latency) {
    this.updateMetrics();

    this.totalTokens += tokens;
    this.respTime += latency;
    this.apiCalls++;
    this.totalCalls++;
  }

  // updateFailedCalls(retrySeconds) { // ID05042024.o
  updateFailedCalls(status, retrySeconds) { // ID05042024.n
    this.updateMetrics();

    this.timeMarker = Date.now() + (retrySeconds * 1000);
    this.failedCalls++;

    if ( status === 429 ) // ID05042024.n
      this.throttledCalls++;
    else if ( status === 400 ) 
      this.filteredCalls++;

    this.totalCalls++;
  }

  updateMetrics() {
    let ctime = Date.now();

    if ( ctime > this.endTime ) {
      let sdate = new Date(this.startTime).toLocaleString();
      let tokens_per_call = (this.apiCalls > 0) ? (this.totalTokens / this.apiCalls) : 0;
      let latency = (this.respTime > 0) ? (this.respTime / this.apiCalls) : 0;
      let kTokens = (this.totalTokens > 1000) ? (this.totalTokens / 1000) : this.totalTokens;
      
      let his_obj = {
        collectionTime: sdate,
        collectedMetrics : {
          apiCalls: this.apiCalls,
          failedApiCalls: this.failedCalls,
	  throttledApiCalls: this.throttledCalls, // ID05042024.n
	  filteredApiCalls: this.filteredCalls, // ID05042024.n
          totalApiCalls: this.totalCalls,
	  throughput: {
            kTokensPerWindow: kTokens,
	    requestsPerWindow: (kTokens * 6),
            avgTokensPerCall: tokens_per_call,
            avgRequestsPerCall: (tokens_per_call * 6) / 1000,
	    tokensPerMinute: (this.totalTokens / this.cInterval), // ID05042024.n
	    requestsPerMinute: (this.apiCalls / this.cInterval) // ID05042024.n
	  },
	  latency: {
            avgResponseTimeMsec: latency
	  }
        }
      };
      this.historyQueue.enqueue(his_obj);

      this.apiCalls = 0;
      this.failedCalls = 0;
      this.throttledCalls = 0; // ID05042024.n
      this.filteredCalls = 0; // ID05042024.n
      this.totalCalls = 0;
      this.totalTokens = 0;
      this.respTime = 0;

      this.startTime = Date.now();
      this.endTime = this.startTime + (this.cInterval * 60 * 1000);
    };
  }

  toJSON() {
    let kTokens = (this.totalTokens > 1000) ? (this.totalTokens / 1000) : this.totalTokens;

    return {
      apiCalls: this.apiCalls,
      failedApiCalls: this.failedCalls,
      throttledApiCalls: this.throttledCalls, // ID05042024.n
      filteredApiCalls: this.filteredCalls, // ID05042024.n
      totalApiCalls: this.totalCalls,
      kInferenceTokens: kTokens,
      history: this.historyQueue.queueItems
    };
  }
}

module.exports = AzOaiEpMetrics;
