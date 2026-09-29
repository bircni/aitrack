import './styles.css';
import { mount } from 'svelte';

import App from './App.svelte';

const target = document.querySelector('#app');
if (target) mount(App, { target });
