## Created with Capacitor Create App

This app was created using [`@capacitor/create-app`](https://github.com/ionic-team/create-capacitor-app),
and comes with a very minimal shell for building an app.

I followed the following steps:

```
# Make a new Capacitor app (uses Vite under the hood)
npm create @capacitor/app@latest
# Answer the prompts (app name/id, web framework).
cd <your-app-folder>

# Run web dev server to verify
npm run dev
```

### Running and building

```
# Create production web build (goes to e.g. dist/)
npm run build

# Add native platforms
npx cap add android
npx cap add ios

# Copy web build into native projects (do this after each web build)
npx cap copy

# Open in IDEs
npx cap open android
npx cap open ios

```

Then we can build using

```
npm run build
npx cap sync android
```