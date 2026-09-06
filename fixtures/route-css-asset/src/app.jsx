import { About } from './about.jsx';
import { Home } from './home.jsx';
import { Shared } from './shared.jsx';

export function App() {
  return [Home(), About(), Shared()];
}
