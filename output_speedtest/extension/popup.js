let factHistory = [];
let capybaraCount = 0;

chrome.storage.local.get(['factHistory'], function(result) {
    if (result.factHistory) {
        factHistory = result.factHistory;
    }
});

document.addEventListener('DOMContentLoaded', function() {
    const currentFactElement = document.getElementById('current-fact');
    const newFactBtn = document.getElementById('new-fact-btn');
    const toggleHistoryBtn = document.getElementById('toggle-history-btn');
    const historyContainer = document.getElementById('history-container');
    const historyList = document.getElementById('history-list');

    let historyVisible = false;

    function fetchNewFact() {
        currentFactElement.innerHTML = '<div class="loading">Loading new fact...</div>';

        fetch('https://api.capy.lol/v1/fact')
            .then(response => response.json())
            .then(data => {
                const fact = data.data.fact;
                currentFactElement.textContent = fact;

                factHistory.unshift(fact);

                if (factHistory.length > 50) {
                    factHistory = factHistory.slice(0, 50);
                }

                chrome.storage.local.set({'factHistory': factHistory});

                updateHistoryDisplay();
                updateToggleButton();
            })
            .catch(error => {
                console.error('Error fetching fact:', error);
                currentFactElement.textContent = 'Could not load capybara fact. Try again!';
            });
    }

    function updateHistoryDisplay() {
        historyList.innerHTML = '';
        factHistory.forEach((fact, index) => {
            const historyItem = document.createElement('div');
            historyItem.className = 'history-item';
            historyItem.textContent = `${index + 1}. ${fact}`;
            historyList.appendChild(historyItem);
        });
    }

    chrome.storage.local.get(['factHistory'], function(result) {
        if (result.factHistory) {
            factHistory = result.factHistory;
            updateHistoryDisplay();
            updateToggleButton();
        }
    });

    function updateToggleButton() {
        toggleHistoryBtn.textContent = `${historyVisible ? 'Hide' : 'Show'} History (${factHistory.length})`;
    }

    function toggleHistory() {
        historyVisible = !historyVisible;
        historyContainer.style.display = historyVisible ? 'block' : 'none';
        updateToggleButton();
    }


    function incrementCapybaraCount() {
        capybaraCount++;
        chrome.storage.sync.set({'capybaraCount': capybaraCount});
        console.log('Capybara interactions (global):', capybaraCount);
    }

    chrome.storage.sync.get(['capybaraCount'], function(result) {
        if (result.capybaraCount) {
            capybaraCount = result.capybaraCount;
            console.log('Restored capybara count from storage:', capybaraCount);
        }
    });

    newFactBtn.addEventListener('click', () => {
        fetchNewFact();
        incrementCapybaraCount();
    });
    toggleHistoryBtn.addEventListener('click', toggleHistory);

    fetchNewFact();
});