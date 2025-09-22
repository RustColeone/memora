import threading
from kivy.app import App
from kivy.uix.boxlayout import BoxLayout
from kivy.clock import mainthread

# This is the modern way to handle platform-specific code
from kivy.utils import platform

# Import your Flask app instance from your server file
from server import app as flask_app

# The new AndroidWebView widget
class AndroidWebView(BoxLayout):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        if platform == 'android':
            self.create_webview()

    @mainthread
    def create_webview(self):
        from jnius import autoclass
        # PythonActivity is the main entry point for a Kivy app on Android
        PythonActivity = autoclass('org.kivy.android.PythonActivity')
        # Android native classes
        WebView = autoclass('android.webkit.WebView')
        WebViewClient = autoclass('android.webkit.WebViewClient')
        
        # Get the current running activity
        activity = PythonActivity.mActivity
        
        # Create the WebView and set its client
        self.webview = WebView(activity)
        self.webview.setWebViewClient(WebViewClient())
        
        # Add the WebView to the Kivy app's main layout
        activity.addContentView(self.webview, self.proxy_view.getLayoutParams())

    @mainthread
    def load_url(self, url):
        if platform == 'android':
            self.webview.loadUrl(url)

# Function to run the Flask server
def run_flask():
    flask_app.run(host='0.0.0.0', port=5050)

# --- Kivy App Class ---
class MemoApp(App):
    def build(self):
        # Start the Flask server in a separate thread
        flask_thread = threading.Thread(target=run_flask)
        flask_thread.daemon = True
        flask_thread.start()

        # Create our webview widget
        self.webview_widget = AndroidWebView()
        
        # Load the URL after a short delay to ensure the server is up
        from kivy.clock import Clock
        Clock.schedule_once(lambda dt: self.webview_widget.load_url("http://127.0.0.1:5050/"), 1)
        
        return self.webview_widget

# --- Run the Kivy App ---
if __name__ == '__main__':
    MemoApp().run()