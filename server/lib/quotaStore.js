// quotaStore.js
let quota = {
    used: 0,
    limit: 10000,
    lastReset: new Date().toDateString()
};

function resetIfNeeded() {
    const today = new Date().toDateString();
    if (quota.lastReset !== today) {
        quota.used = 0;
        quota.lastReset = today;
    }
}

function addUsage(units) {
    resetIfNeeded();
    quota.used += units;
}

function getQuota() {
    resetIfNeeded();
    return {
        used: quota.used,
        limit: quota.limit,
        remaining: quota.limit - quota.used
    };
}

module.exports = { addUsage, getQuota };