

npm install tailwindcss @tailwindcss/cli


```css
/* static/src/input.css */
@import "tailwindcss" source(none);

@source "../../templates/**/*.html";
/* Tell Tailwind what to watch/scan  for changes */
```


https://tailwindcss.com/docs/detecting-classes-in-source-files#explicitly-registering-sources




npx @tailwindcss/cli -i ./app/static/css/input.css -o ./app/static/css/output.css --watch
