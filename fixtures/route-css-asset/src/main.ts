import { App } from './app.jsx';

const el = document.getElementById('app');
if (el !== null) {
  el.textContent = JSON.stringify(App());
}
