// utils.js
function getUptime(startTime) {
    const now = new Date();
    const diff = now - startTime;
    
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    
    let uptimeStr = '';
    if (hours > 0) uptimeStr += `${hours} hours `;
    if (minutes > 0) uptimeStr += `${minutes} minutes `;
    if (seconds > 0) uptimeStr += `${seconds} seconds`;
    
    return uptimeStr.trim();
}

module.exports = {
    getUptime
};