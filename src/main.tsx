/* @refresh reload */
import '@fontsource-variable/literata/index.css';
import './styles.css';
import { render } from 'solid-js/web';
import { App } from './App';

render(() => <App />, document.getElementById('root')!);
