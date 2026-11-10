(() => {
  const opener = document.querySelector('button[aria-controls="workstep-navigation"]');
  const navigation = document.getElementById('workstep-navigation');
  if (!opener || !navigation) return false;
  if (opener.getAttribute('aria-expanded') === 'true') navigation.querySelector('button.navigation-close')?.click();
  else opener.click();
  return true;
})();
