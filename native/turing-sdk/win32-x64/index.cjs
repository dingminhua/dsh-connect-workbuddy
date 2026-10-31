'use strict';

const path = require('node:path');

let binding;
let loadError;

const supportedPlatform = process.platform === 'darwin' || process.platform === 'win32';

if (supportedPlatform) {
    try {
        // eslint-disable-next-line node/no-missing-require
        binding = require(path.join(__dirname, 'build', 'Release', 'turing_sdk.node'));
    } catch (error) {
        loadError = error;
        binding = null;
    }
} else {
    binding = null;
}

function isSupported() {
    return supportedPlatform && binding != null;
}

function getLoadError() {
    return loadError ? String(loadError.message || loadError) : null;
}

function requireBinding() {
    if (!binding) {
        throw new Error(`Turing SDK native binding unavailable: ${getLoadError() || `unsupported platform ${process.platform}`}`);
    }
    return binding;
}

module.exports = {
    isSupported,
    getLoadError,
    configure(channelId, productName, productVersion) {
        return requireBinding().configure(channelId, productName, productVersion);
    },
    fetchDeviceToken(options) {
        return requireBinding().fetchDeviceToken(options);
    },
};
