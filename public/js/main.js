function toggleDD(e){
  const dd = e.target.closest('.dd');
  dd.classList.toggle('open');
  document.addEventListener('click', function onDoc(ev){
    if (!ev.target.closest('.dd')) { dd.classList.remove('open'); document.removeEventListener('click', onDoc); }
  });
}

//funcion carril
function scrollCarril(dir){
  const el = document.getElementById('carril');
  if(!el) return;
  const card = el.querySelector('.card-product');
  const step = card ? card.offsetWidth + 12 : 240; // ancho tarjeta + gap
  el.scrollBy({ left: dir * step, behavior: 'smooth' });
}
