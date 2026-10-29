// ES5: reach the standalone update page before loading modern app JS.
        (function () {
            var chrome = navigator.userAgent.match(/Chrome\/(\d+)/);
            try {
                if (chrome && Number(chrome[1]) < 85) throw new Error('Old WebView');
                new Function('var a = {}; a.b ||= 1; return a?.b ?? 0;');
            } catch (error) { location.replace('/static/webview-update.html'); }
        })();
