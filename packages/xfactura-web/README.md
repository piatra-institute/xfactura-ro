# xfactura.ro


[`xfactura.ro`](https://xfactura.ro) is a web service for generating electronic invoices based on the EU specification (EN 16931), Romanian Core Invoice Usage Specifications (CIUS)

`xfactura.ro` is using [josemmo/einvoicing](https://github.com/josemmo/einvoicing) for the generation of the `xml`

`xfactura.ro` is not associated with any institution

`xfactura.ro` is using no external database, all the data is stored locally in the browser


## self-hosting

`xfactura.ro` can be self-hosted using [`docker`](https://docs.docker.com/engine/install):

``` bash
docker pull plurid/xfactura-ro

docker run -d -p 54999:54999 plurid/xfactura-ro
```

then accessing [`http://localhost:54999`](http://localhost:54999)
