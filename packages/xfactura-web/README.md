# xfactura.ro


[`xfactura.ro`](https://xfactura.ro) is a web service for generating electronic invoices based on the EU specification (EN 16931), Romanian Core Invoice Usage Specifications (CIUS)

`xfactura.ro` writes the `xml` in the browser with `xfactura-core`, so invoices never leave the device; earlier versions used [josemmo/einvoicing](https://github.com/josemmo/einvoicing)

`xfactura.ro` is not associated with any public institution

`xfactura.ro` is using no external database, all the data is stored locally in the browser


## self-hosting

`xfactura.ro` can be self-hosted using [`docker`](https://docs.docker.com/engine/install):

``` bash
docker pull xfactura-ro-web

docker run -d -p 54999:54999 xfactura-ro-web
```

then accessing [`http://localhost:54999`](http://localhost:54999)
