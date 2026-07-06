function replaceImagesWithCapybaras() {
    const images = document.querySelectorAll('img');
    console.log('Found', images.length, 'images to replace on', window.location.hostname);

    images.forEach(async (img, index) => {
        try {
            const response = await fetch('https://api.capy.lol/v1/capybara');
            const data = await response.json();

            console.log(`Replacing image ${index + 1}:`, img.src, 'with capybara:', data.data.url);

            const originalSrc = img.src;
            const originalWidth = img.offsetWidth;
            const originalHeight = img.offsetHeight;

            img.src = data.data.url;
            img.alt = 'Capybara replacement image';
            img.style.border = '2px solid #8B4513';
            img.style.borderRadius = '5px';
            img.style.transition = 'all 0.3s ease';
            img.style.objectFit = 'cover';

            if (originalWidth && originalHeight) {
                img.style.width = originalWidth + 'px';
                img.style.height = originalHeight + 'px';
            }

            img.onerror = function() {
                console.warn('Failed to load capybara, reverting:', originalSrc);
            };
        } catch (error) {
            console.error('Error fetching capybara image:', error);
        }
    });
}

function addCapybaraIndicator() {
    const indicator = document.createElement('div');
    indicator.innerHTML = '🦫';
    indicator.title = 'Capybara Extension Active (MV2 Background Script can modify DOM)';
    indicator.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 40px;
        height: 40px;
        background: #8B4513;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 20px;
        z-index: 9999;
        box-shadow: 0 2px 10px rgba(0,0,0,0.3);
        cursor: pointer;
        animation: pulse 2s infinite;
    `;

    const style = document.createElement('style');
    style.textContent = `
        @keyframes pulse {
            0%, 100% { transform: scale(1); opacity: 1; }
            50% { transform: scale(1.1); opacity: 0.8; }
        }
    `;
    document.head.appendChild(style);
    document.body.appendChild(indicator);

    indicator.addEventListener('click', function() {
        alert('🦫 Capybara Extension is active!\\n\\nThis indicator was added by the MV2 persistent background script.\\nIn MV3, service workers cannot directly modify the DOM like this.');
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
        setTimeout(() => {
            replaceImagesWithCapybaras();
            addCapybaraIndicator();
        }, 1000);
    });
} else {
    setTimeout(() => {
        replaceImagesWithCapybaras();
        addCapybaraIndicator();
    }, 1000);
}

const observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(mutation) {
        if (mutation.type === 'childList') {
            mutation.addedNodes.forEach(function(node) {
                if (node.nodeType === 1) {
                    const newImages = node.querySelectorAll ? node.querySelectorAll('img') : [];
                    if (node.tagName === 'IMG') {
                        newImages.push(node);
                    }

                    newImages.forEach(async (img) => {
                        try {
                            const response = await fetch('https://api.capy.lol/v1/capybara');
                            const data = await response.json();

                            const originalWidth = img.offsetWidth;
                            const originalHeight = img.offsetHeight;

                            img.src = data.data.url;
                            img.alt = 'Capybara replacement image';
                            img.style.border = '2px solid #8B4513';
                            img.style.borderRadius = '5px';
                            img.style.objectFit = 'cover';

                            if (originalWidth && originalHeight) {
                                img.style.width = originalWidth + 'px';
                                img.style.height = originalHeight + 'px';
                            }
                        } catch (error) {
                            console.error('Error fetching capybara image:', error);
                        }
                    });
                }
            });
        }
    });
});

observer.observe(document.body, {
    childList: true,
    subtree: true
});