import { initFederation } from '@angular-architects/native-federation';

initFederation()
  .catch((error) => console.error(error))
  .then(() => import('./bootstrap'))
  .catch((error) => console.error(error));
