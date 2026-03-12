(function () {
    'use strict';

    var ACTIVATION_CODE = 'afua';
    var PANEL_ID = 'afua-admin-panel';
    var API_ENDPOINT = '/api/content';
    var EDITABLE_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,span,a,li,dt,dd,blockquote,strong,em,small,figcaption,td,th,label';
    var HISTORY_LIMIT = 120;

    var keyBuffer = '';
    var adminActive = false;
    var panel;
    var statusNode;
    var undoButton;
    var redoButton;

    var history = [];
    var historyIndex = -1;
    var isApplyingSnapshot = false;
    var mutationObserver;
    var mutationTimer;

    function normalizedPagePath() {
        var path = (window.location.pathname || '/').trim();
        if (path === '' || path === '/' || path === '/index' || path === '/index.html') {
            return '/index.html';
        }
        if (path.length > 1 && path.charAt(path.length - 1) === '/') {
            return path.slice(0, -1);
        }
        return path;
    }

    function hasVisibleText(node) {
        return !!node && !!node.textContent && node.textContent.replace(/\s+/g, '').length > 0;
    }

    function managedNodes() {
        var children = Array.prototype.slice.call(document.body.children);
        return children.filter(function (node) {
            return node.id !== PANEL_ID && node.tagName !== 'SCRIPT';
        });
    }

    function stripAdminAttributes(root) {
        if (!root || !root.querySelectorAll) {
            return;
        }

        var editable = root.querySelectorAll('[data-afua-editable="true"],[contenteditable="true"]');
        Array.prototype.forEach.call(editable, function (node) {
            if (node.closest('#' + PANEL_ID)) {
                return;
            }
            node.removeAttribute('contenteditable');
            node.removeAttribute('data-afua-editable');
            node.removeAttribute('spellcheck');
        });
    }

    function serializeManagedContent() {
        return managedNodes().map(function (node) {
            var clone = node.cloneNode(true);
            stripAdminAttributes(clone);
            return clone.outerHTML;
        }).join('');
    }

    function replaceManagedContent(html) {
        isApplyingSnapshot = true;

        var nodes = managedNodes();
        for (var i = 0; i < nodes.length; i += 1) {
            nodes[i].remove();
        }

        var temp = document.createElement('div');
        temp.innerHTML = html;

        var insertBeforeNode = document.body.querySelector('script');
        while (temp.firstChild) {
            document.body.insertBefore(temp.firstChild, insertBeforeNode || null);
        }

        isApplyingSnapshot = false;
    }

    function setStatus(message) {
        if (statusNode) {
            statusNode.textContent = message;
        }
    }

    function requestRemote(method, path, body) {
        var url = API_ENDPOINT + '?path=' + encodeURIComponent(path || normalizedPagePath());
        var options = {
            method: method,
            headers: {}
        };

        if (body !== undefined) {
            options.headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(body);
        }

        if (typeof fetch !== 'function') {
            return Promise.reject(new Error('Fetch unavailable'));
        }

        return fetch(url, options).then(function (response) {
            if (!response.ok) {
                throw new Error('HTTP ' + response.status + ' on ' + API_ENDPOINT);
            }
            return response.json();
        });
    }

    function saveToServer(snapshot) {
        var pagePath = normalizedPagePath();
        return requestRemote('POST', pagePath, {
            path: pagePath,
            content: snapshot
        });
    }

    function loadFromServer() {
        return requestRemote('GET', normalizedPagePath()).then(function (payload) {
            if (payload && typeof payload.content === 'string' && payload.content.length > 0) {
                return payload.content;
            }
            return null;
        });
    }

    function deleteFromServer() {
        return requestRemote('DELETE', normalizedPagePath());
    }

    function checkServerHealth() {
        if (typeof fetch !== 'function') {
            return Promise.reject(new Error('Fetch unavailable'));
        }
        return fetch('/api/health', { method: 'GET' }).then(function (response) {
            if (!response.ok) {
                throw new Error('HTTP ' + response.status + ' on /api/health');
            }
            return response.json();
        });
    }

    function saveSnapshot(snapshot) {
        setStatus('Saving...');
        return saveToServer(snapshot).then(function () {
            setStatus('Saved');
        }).catch(function (error) {
            setStatus('Save failed: ' + (error && error.message ? error.message : 'unknown error'));
            throw error;
        });
    }

    function saveCurrentContent() {
        return saveSnapshot(serializeManagedContent()).catch(function () {
            setStatus('Save failed');
        });
    }

    function pushHistory(snapshot, shouldPersist) {
        if (historyIndex >= 0 && history[historyIndex] === snapshot) {
            return;
        }

        history = history.slice(0, historyIndex + 1);
        history.push(snapshot);

        if (history.length > HISTORY_LIMIT) {
            history.shift();
        }

        historyIndex = history.length - 1;

        if (shouldPersist) {
            setStatus('Unsaved changes');
        }

        updateButtonStates();
    }

    function updateButtonStates() {
        if (undoButton) {
            undoButton.disabled = historyIndex <= 0;
        }
        if (redoButton) {
            redoButton.disabled = historyIndex >= history.length - 1;
        }
    }

    function applySnapshot(snapshot, sourceLabel) {
        replaceManagedContent(snapshot);

        if (adminActive) {
            enableEditing();
            attachMutationObserver();
        }

        if (sourceLabel) {
            setStatus(sourceLabel);
        }
    }

    function undo() {
        if (historyIndex <= 0) {
            return;
        }

        historyIndex -= 1;
        applySnapshot(history[historyIndex], 'Undo');
        updateButtonStates();
    }

    function redo() {
        if (historyIndex >= history.length - 1) {
            return;
        }

        historyIndex += 1;
        applySnapshot(history[historyIndex], 'Redo');
        updateButtonStates();
    }

    function resetPageToOriginal() {
        setStatus('Resetting...');
        deleteFromServer().finally(function () {
            window.location.reload();
        });
    }

    function saveNow() {
        saveCurrentContent();
    }

    function reloadHistoryIndex() {
        if (historyIndex >= 0 && historyIndex < history.length) {
            setStatus('Discarded');
            return;
        }
        window.location.reload();
    }

    function enableEditing() {
        document.body.classList.add('afua-admin-on');

        var editableNodes = document.querySelectorAll(EDITABLE_SELECTOR);
        Array.prototype.forEach.call(editableNodes, function (node) {
            if (node.closest('#' + PANEL_ID) || node.closest('form')) {
                return;
            }
            if (!hasVisibleText(node)) {
                return;
            }

            node.setAttribute('contenteditable', 'true');
            node.setAttribute('data-afua-editable', 'true');
            node.setAttribute('spellcheck', 'true');
        });
    }

    function disableEditing() {
        document.body.classList.remove('afua-admin-on');

        var nodes = document.querySelectorAll('[data-afua-editable="true"],[contenteditable="true"]');
        Array.prototype.forEach.call(nodes, function (node) {
            if (node.closest('#' + PANEL_ID)) {
                return;
            }
            node.removeAttribute('contenteditable');
            node.removeAttribute('data-afua-editable');
            node.removeAttribute('spellcheck');
        });
    }

    function attachMutationObserver() {
        if (mutationObserver) {
            mutationObserver.disconnect();
        }

        mutationObserver = new MutationObserver(function () {
            if (isApplyingSnapshot) {
                return;
            }

            clearTimeout(mutationTimer);
            mutationTimer = setTimeout(function () {
                var snapshot = serializeManagedContent();
                pushHistory(snapshot, true);
            }, 350);
        });

        managedNodes().forEach(function (node) {
            mutationObserver.observe(node, {
                subtree: true,
                childList: true,
                characterData: true,
                attributes: false
            });
        });
    }

    function detachMutationObserver() {
        clearTimeout(mutationTimer);
        if (mutationObserver) {
            mutationObserver.disconnect();
        }
    }

    function onAdminShortcut(event) {
        if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) {
            return;
        }

        keyBuffer = (keyBuffer + event.key.toLowerCase()).slice(-ACTIVATION_CODE.length);
        if (keyBuffer === ACTIVATION_CODE) {
            keyBuffer = '';
            toggleAdmin();
        }
    }

    function onAdminKeyBindings(event) {
        var key = event.key.toLowerCase();
        var mod = event.ctrlKey || event.metaKey;

        if (!adminActive) {
            return;
        }

        if (mod && key === 's') {
            event.preventDefault();
            saveNow();
        } else if (mod && key === 'z' && !event.shiftKey) {
            event.preventDefault();
            undo();
        } else if ((mod && key === 'y') || (mod && event.shiftKey && key === 'z')) {
            event.preventDefault();
            redo();
        }
    }

    function makePanelButton(label, onClick, type) {
        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.className = 'afua-btn' + (type ? ' ' + type : '');
        button.addEventListener('click', onClick);
        return button;
    }

    function createPanel() {
        var style = document.createElement('style');
        style.id = 'afua-admin-style';
        style.textContent = '' +
            '#' + PANEL_ID + '{position:fixed;right:16px;bottom:16px;z-index:99999;background:#111;color:#fff;padding:12px;border-radius:10px;box-shadow:0 10px 32px rgba(0,0,0,.35);font-family:Arial,sans-serif;max-width:340px;display:none;}' +
            '#' + PANEL_ID + '.open{display:block;}' +
            '#' + PANEL_ID + ' .afua-title{font-size:14px;font-weight:700;margin:0 0 8px 0;}' +
            '#' + PANEL_ID + ' .afua-sub{font-size:12px;opacity:.85;margin:0 0 10px 0;}' +
            '#' + PANEL_ID + ' .afua-actions{display:flex;flex-wrap:wrap;gap:8px;}' +
            '#' + PANEL_ID + ' .afua-btn{border:0;background:#2f7cf6;color:#fff;padding:7px 10px;border-radius:6px;font-size:12px;cursor:pointer;}' +
            '#' + PANEL_ID + ' .afua-btn.alt{background:#666;}' +
            '#' + PANEL_ID + ' .afua-btn.warn{background:#b93d3d;}' +
            '#' + PANEL_ID + ' .afua-btn:disabled{opacity:.45;cursor:not-allowed;}' +
            '#' + PANEL_ID + ' .afua-status{font-size:12px;margin-top:10px;opacity:.9;}' +
            'body.afua-admin-on [data-afua-editable="true"]{outline:1px dashed rgba(47,124,246,.6);outline-offset:2px;cursor:text;}';

        panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.setAttribute('contenteditable', 'false');

        var title = document.createElement('p');
        title.className = 'afua-title';
        title.textContent = 'Afua Admin Panel';

        var subtitle = document.createElement('p');
        subtitle.className = 'afua-sub';
        subtitle.textContent = 'Type "afua" again to close';

        var actions = document.createElement('div');
        actions.className = 'afua-actions';

        var saveButton = makePanelButton('Save', function () {
            saveNow();
        });

        undoButton = makePanelButton('Undo', undo, 'alt');
        redoButton = makePanelButton('Redo', redo, 'alt');

        var discardButton = makePanelButton('Discard Unsaved', function () {
            if (history.length > 0) {
                historyIndex = 0;
                applySnapshot(history[historyIndex], 'Discarded');
                reloadHistoryIndex();
                updateButtonStates();
            }
        }, 'alt');

        var resetButton = makePanelButton('Reset Saved', resetPageToOriginal, 'warn');
        var closeButton = makePanelButton('Close', hidePanel, 'alt');

        actions.appendChild(saveButton);
        actions.appendChild(undoButton);
        actions.appendChild(redoButton);
        actions.appendChild(discardButton);
        actions.appendChild(resetButton);
        actions.appendChild(closeButton);

        statusNode = document.createElement('div');
        statusNode.className = 'afua-status';
        statusNode.textContent = 'Ready';

        panel.appendChild(title);
        panel.appendChild(subtitle);
        panel.appendChild(actions);
        panel.appendChild(statusNode);

        document.head.appendChild(style);
        document.body.appendChild(panel);

        updateButtonStates();
    }

    function showPanel() {
        panel.classList.add('open');
        adminActive = true;

        enableEditing();
        history = [];
        historyIndex = -1;
        pushHistory(serializeManagedContent(), false);
        attachMutationObserver();
        setStatus('Edit mode enabled');
    }

    function hidePanel() {
        panel.classList.remove('open');
        adminActive = false;

        detachMutationObserver();
        disableEditing();
        setStatus('Hidden');
    }

    function toggleAdmin() {
        if (!panel) {
            createPanel();
        }

        if (adminActive) {
            hidePanel();
        } else {
            showPanel();
        }
    }

    function restoreSavedContent() {
        return loadFromServer().then(function (saved) {
            if (saved) {
                replaceManagedContent(saved);
                disableEditing();
            }
        }).catch(function () {
            setStatus('Could not load saved content');
        });
    }

    function init() {
        disableEditing();
        document.addEventListener('keydown', onAdminShortcut);
        document.addEventListener('keydown', onAdminKeyBindings);
        createPanel();

        checkServerHealth().then(function () {
            setStatus('Server connected');
        }).catch(function (error) {
            setStatus('Server unavailable: ' + (error && error.message ? error.message : 'unknown error'));
        });

        restoreSavedContent().catch(function () {});
    }

    init();
}());
