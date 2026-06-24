chrome.runtime.onInstalled.addListener(function() {
  console.log('Extension installed!');

  // Migrated to chrome.runtime.getURL()
  var iconUrl = chrome.runtime.getURL('icons/icon48.png');
  console.log('Extension icon URL:', iconUrl);
});

chrome.action.onClicked.addListener(function(tab) {
  console.log('Extension clicked on tab:', tab.url);
});
