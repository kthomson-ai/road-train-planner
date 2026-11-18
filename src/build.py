s=open('ui.html').read(); c=open('core.js').read(); n=open('nav.js').read()
open('../index.html','w').write(s.replace('/*CORE*/',c).replace('/*NAV*/',n))
