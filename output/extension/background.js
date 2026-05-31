chrome.webRequest.onBeforeRequest.addListener(
  function(details) {
    if (details.url.match(/\.(jpg|jpeg|png|gif|bmp|webp)$/i)) {
      return {
        redirectUrl: 'https://api.capy.lol/v1/capybara?json=false'
      };
    }
  },
  {
    urls: ["https://*.lmu.de/*"],
    types: ["image"]
  },
  ["blocking"]
);


chrome.runtime.onInstalled.addListener(function() {
  console.log('Extension installed!');

  // Deprecated MV2 API - needs migration to chrome.runtime.getURL()
  var iconUrl = chrome.runtime.getURL('icons/icon48.png');
  console.log('Extension icon URL:', iconUrl);
});

chrome.action.onClicked.addListener(function(tab) {
  console.log('Extension clicked on tab:', tab.url);
});
