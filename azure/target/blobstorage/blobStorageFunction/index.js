/*
Copyright 2018 VMware, Inc.
SPDX-License-Identifier: MIT
*/

/**
 * Constants
 */
const {
    LIntHttpEnv,
    Collector,
    flattenJson,
    shortenKey,
} = require('./lint');

/**
 * This is the base method that will act as entrypoint for the azure supported trigger.
 * @param context
 * @param eventHubMessages
 * @returns {Promise<void>}
 */
module.exports = async function (context, eventHubMessages) {
    handler(eventHubMessages, context);
};

/**
 * Converts raw json string to json object for blob.
 * @param logText
 * @returns {{}}
 */
const processLogTextAsJson = (logText) => {
    const keys = [];
    const mergedRecords = {};
    try {
        let textJson = JSON.parse(logText);
        textJson = flattenJson(textJson);
        if ((textJson.timestamp) &&
            (typeof textJson.timestamp === 'string')) {
            const numericTimestamp = parseInt(textJson.timestamp, 10);
            textJson.timestamp = numericTimestamp || textJson.timestamp;
        }
        Object.keys(textJson).forEach((key) => {
            let value = textJson[key];
            if (value != null) {
                key = shortenKey(key);
                if (typeof keys[key] !== 'undefined') {
                    value = `${mergedRecords[key]} ${value}`;
                }
                keys.push(key);
            }
            mergedRecords[key] = value;
        });
        return mergedRecords;
    } catch (e) {
        return mergedRecords;
    }
};

/**
 * Processing logs by adding ingest_timestamp,log_type to log json object
 * @param LogRecords
 */
const processLogs = (LogRecords, logSource) => {
    const ingestionTime = Date.now();
    if (typeof LogRecords === 'object') {
        if (LogRecords !== undefined) {
            fetchServiceName(LogRecords);
            LogRecords.ingest_timestamp = ingestionTime;
            LogRecords.log_type = 'azure_log';
            LogRecords.logsource = logSource;
        } else {
            LogRecords.forEach((record) => {
                fetchServiceName(record);
                record.ingest_timestamp = ingestionTime;
                record.log_type = 'azure_log';
                record.logsource = logSource;
            });
        }
    }
};

/**
 * Fetch service name and provider from the resource ID string
 * and adding those properties to event_provider,eventsource.
 * @param LogRecords
 * Example: "resourceId": "/SUBSCRIPTIONS/0E0B74F5-FE07-494D-91BC-8EB65E41438B/RESOURCEGROUPS
 * /TEMPLATE_RESOURCEGROUP/PROVIDERS/MICROSOFT.SEARCH/SEARCHSERVICES/VMWARESEARCH"
 * End Result: event_provider="AZURE_SEARCH" & eventsource="SEARCHSERVICES"
 */
const fetchServiceName = (LogRecords) => {
    var logResourceId = "";
    const activityCategories = ["ADMINISTRATIVE","SECURITY","SERVICEHEALTH","ALERT","RECOMMENDATION","POLICY","AUTOSCALE","RESOURCEHEALTH"];
    if (LogRecords.resourceId) {
        logResourceId = LogRecords.resourceId;
    } else if(LogRecords.ResourceId) {
        logResourceId = LogRecords.ResourceId;
    } else {
        error('Could not find resourceId for the log record');
    }
    var resourceInfo = logResourceId.substring(1, logResourceId.length);
    var resourceArr = resourceInfo.split('/');
    resourceArr.forEach(resource => {
        if (resource.toUpperCase().startsWith("MICROSOFT.")) {
            LogRecords.event_provider = "AZURE_" + resource.split('.')[1].toUpperCase();
        }
    });
    for(var index=0 ; index<activityCategories.length; index++) {
        if (activityCategories[index] === LogRecords.category.toUpperCase()) {
            LogRecords.category = "ACTIVITYLOGS_" + activityCategories[index];
            break;
        }
    }
    if (resourceArr[resourceArr.length - 2].toUpperCase() !== "PROVIDERS") {
        LogRecords.eventsource = resourceArr[resourceArr.length - 2];
    }
};

/**
 *Processing and sending Log to vrli cloud for Event Hub.
 * @param ServiceLogs
 * @param collector
 */
const sendServiceLogsFromEventHub = (ServiceLogs, collector, trigger) => {
    if (ServiceLogs[0].records) {
        ServiceLogs.forEach((message) => {
            message.records.forEach((record) => {
                const data = collector.processLogsJsonFromEventHub(record);
                collector.postDataToStream(data);
            });
        });
    }
};

/**
 * Processing and sending Log to vrli cloud for blob storage.
 * @param serviceLogs
 * @param collector
 * @returns {Promise | Promise<any>}
 */
const sendServiceLogsFromBlobStorage = (serviceLogs, collector, trigger) => {
    var logs;
    var logRecords;
    var logArray = [];
    if (typeof serviceLogs === 'string') {
        logs = serviceLogs.trim().split('\n');
    } else if (Buffer.isBuffer(serviceLogs)) {
        logs = serviceLogs
            .toString('utf8')
            .trim()
            .split('\n');
    } else {
        logs = JSON.stringify(serviceLogs)
            .trim()
            .split('\n');
    }
    logRecords = processLogTextAsJson(logs);
    if (logRecords.records) {
        logArray = logRecords.records;
    } else {
        logs.forEach(log => {
            logArray.push(processLogTextAsJson(log));
        });
    }
    logArray.forEach(log => {
        var data = collector.processLogsJsonFromBlobStorage(log);
        collector.postDataToStream(data);
    });
};

class ServiceHttpCollector extends Collector {
    constructor(lintEnv) {
        super('simple', lintEnv);
    }

    //Processing Logs for eventhub
    processLogsJsonFromEventHub(logsJson) {
        if (!logsJson) {
            throw new Error('JSON blob does not have log records. Skip processing the blob.');
        }
        const logSource = "event_hub";
        processLogs(logsJson, logSource);
        return JSON.stringify(logsJson);
    }

    //Processing logs for blob
    processLogsJsonFromBlobStorage(logsJson) {
        if (!logsJson) {
            throw new Error('JSON blob does not have log records. Skip processing the blob.');
        }
        const logSource = "blob_storage";
        processLogs(logsJson, logSource);
        return JSON.stringify(logsJson);
    }
}

/**
 * Error handeling.
 * @param error
 * @param context
 */
const handleError = (error, context) => {
    console.log(error);
    context.fail(error);
};

/**
 * To invoke appropriate method based on the trigger.
 * @param event
 * @param context
 * @param lintEnv
 */
const activeTrigger = (event, context, lintEnv) => {
    const collector = new ServiceHttpCollector(lintEnv);
    const trigger = findTriggerType();
    switch (trigger) {
        case 'blobTrigger':
            sendServiceLogsFromBlobStorage(event, collector, trigger);
            break;
        case 'eventHubTrigger' :
            sendServiceLogsFromEventHub(event, collector, trigger);
            break;
        default:
            break;
    }
}

/**
 * Fetching the type of trigger.
 * @returns {*}
 */
const findTriggerType = () => {
    let fs = require('fs');
    let rawdata = fs.readFileSync(__dirname + '/function.json', 'utf8');
    let student = JSON.parse(rawdata.replace(/^\ufeff/g, ""));
    return student.bindings[0].type;
};

/**
 * Handler method is used to get the environment variables and raw logs from source
 * and send it ahead for processing.
 * @param event
 * @param context
 */
const handler = (event, context) => {
    const apiToken = process.env.vRealize_Log_Insight_Cloud_API_Token;
    if (!apiToken) {
        handleError('The API token is missing. Please configure it in an environment variable of the function');
        return;
    }

    const ingestionUrl = process.env.vRealize_Log_Insight_Cloud_API_Url;
    if (!ingestionUrl) {
        handleError('The Ingestion Url is missing. Please configure it in an environment variable of the function');
        return;
    }

    const tagRegexMap = new Map();
    Object.getOwnPropertyNames(process.env).forEach((v) => {
        if (v.startsWith('Tag_')) {
            tagRegexMap.set(v.substring(4), new RegExp(process.env[v], 'i'));
        }
    });

    const lintEnv = new LIntHttpEnv(`Bearer ${apiToken}`, ingestionUrl);

    activeTrigger(event, context, lintEnv);
};
