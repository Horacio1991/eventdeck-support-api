// No se utiliza status/payment_id/collection_status de la URL.
const token=location.pathname.split('/').pop();history.replaceState(null,'',location.pathname);
const state=document.getElementById('state'),detail=document.getElementById('detail'),grant=document.getElementById('grant'),button=document.getElementById('refresh');
let timer,attempts=0,busy=false;
async function check(){if(busy)return;busy=true;button.disabled=true;clearTimeout(timer);try{if(!/^[a-f0-9]{64}$/.test(token))throw new Error('Identificador de consulta inválido.');const response=await fetch(`/api/support/status/${token}`,{cache:'no-store'});const data=await response.json();if(!response.ok)throw new Error(data.message||'No se pudo verificar el estado.');grant.hidden=true;
if(data.status==='approved'&&data.accessGranted===true){state.textContent='PAGO APROBADO';detail.textContent='Estado confirmado por el backend consultando Mercado Pago. Acceso de TEST, sin descarga.';grant.hidden=false;}
else if(data.status==='pending'){state.textContent='PAGO PENDIENTE';detail.textContent='Todavía no hay un pago aprobado. No se concedió acceso.';}
else if(data.status==='processing'){state.textContent='PROCESANDO PAGO';detail.textContent='Aún no llegó una confirmación verificable. Si demora, revisá el webhook y los logs de Render.';}
else{state.textContent='PAGO NO APROBADO';detail.textContent='El estado verificado no habilita acceso. Esto incluye rechazos, cancelaciones o reembolsos.';}
if(['pending','processing'].includes(data.status)&&++attempts<30)timer=setTimeout(check,4000);
}catch(error){state.textContent='NO SE PUDO VERIFICAR';detail.textContent=error.message;grant.hidden=true;}finally{busy=false;button.disabled=false;}}
button.addEventListener('click',()=>{attempts=0;check();});check();
