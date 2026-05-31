chrome.runtime.onInstalled.addListener(async () => {
  console.log('Extension installed!');

  // Replace blocking webRequest with declarativeNetRequest
  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules: [{
      id: 1,
      priority: 1,
      action: {
        type: chrome.declarativeNetRequest.Rule.ActionType.REDIRECT,
        redirect: { url: 'https://api.capy.lol/v1/capybara?json=false' }
      },
      condition: {
        urlFilter: 'https://*.lmu.de/*',
        resourceTypes: [chrome.declarativeNetRequest.ResourceType.IMAGE]
      }
    }],
    removeRuleIds: [1]
  });

  // Replace chrome.extension.getURL with chrome.runtime.getURL
  var iconUrl = chrome.runtime.getURL('icons/icon48.png');
  console.log('Extension icon URL:', iconUrl);
});

// Replace chrome.browserAction.onClicked with chrome.action.onClicked
chrome.action.onClicked.addListener(function(tab) {
  console.log('Extension clicked on tab:', tab.url);
});